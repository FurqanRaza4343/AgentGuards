"""Network policy: which addresses an outbound request may never reach.

One deny-set, used by every check, so the literal-host check and the DNS-resolution check can never disagree.
The design follows what the Obscura project (Apache-2.0) documents for its SSRF crate: a single shared policy, checked
after DNS resolution as well as on the literal host, with the IPv4-in-IPv6 forms unwrapped and re-checked.
The ranges are IANA special-purpose allocations. The code here is our own.

Overriding the policy needs an explicit environment variable that is meant for tests only.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpcore
import httpx

ALLOW_ENV = "AGENTGUARD_ALLOW_PRIVATE_NETWORK"

# IPv4 ranges that must never be the target of an outbound request.
_V4_DENY = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8",        # "this" network
    "10.0.0.0/8",       # RFC 1918
    "100.64.0.0/10",    # carrier-grade NAT (some clouds keep metadata here)
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local, including the 169.254.169.254 metadata address
    "172.16.0.0/12",    # RFC 1918
    "192.0.0.0/24",     # IETF protocol assignments (two anycast addresses are carved out below)
    "192.0.2.0/24",     # documentation
    "192.88.99.0/24",   # 6to4 relay anycast
    "192.168.0.0/16",   # RFC 1918
    "198.18.0.0/15",    # benchmarking
    "198.51.100.0/24",  # documentation
    "203.0.113.0/24",   # documentation
    "224.0.0.0/4",      # multicast
    "240.0.0.0/4",      # reserved, including the broadcast address
)]
_V4_ALLOWED_EXCEPTIONS = {ipaddress.ip_address("192.0.0.9"), ipaddress.ip_address("192.0.0.10")}  # globally reachable PCP anycast

# IPv6 prefixes that must never be the target of an outbound request.
_V6_DENY = [ipaddress.ip_network(n) for n in (
    "::/128",           # unspecified
    "::1/128",          # loopback
    "fc00::/7",         # unique local
    "fe80::/10",        # link-local
    "ff00::/8",         # multicast
    "100::/64",         # discard-only
    "64:ff9b:1::/48",   # local-use NAT64
    "2001:db8::/32",    # documentation
    "3fff::/20",        # documentation
)]


class PolicyError(Exception):
    """A request was refused by the network policy."""


def allow_private_network() -> bool:
    """True only when the test-only override is set. Never set it in production."""
    return os.environ.get(ALLOW_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def _v4_forbidden(ip: ipaddress.IPv4Address) -> bool:
    if ip in _V4_ALLOWED_EXCEPTIONS:
        return False
    return any(ip in net for net in _V4_DENY)


def is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address | str) -> bool:
    """True when `ip` must never be reached by an outbound request."""
    if isinstance(ip, str):
        ip = ipaddress.ip_address(ip)
    if isinstance(ip, ipaddress.IPv4Address):
        return _v4_forbidden(ip)

    v6 = ip
    if any(v6 in net for net in _V6_DENY):
        return True

    n = int(v6)
    # IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): unwrap and check the embedded address,
    # so [::ffff:127.0.0.1] and [::ffff:169.254.169.254] cannot slip past the IPv6 rules.
    if v6.ipv4_mapped is not None:
        return _v4_forbidden(v6.ipv4_mapped)
    if (n >> 32) == 0:
        return _v4_forbidden(ipaddress.IPv4Address(n & 0xFFFFFFFF))

    # NAT64 (64:ff9b::/96): the IPv4 address is in the last 32 bits
    if (n >> 32) == int(ipaddress.IPv6Address("64:ff9b::")) >> 32:
        return _v4_forbidden(ipaddress.IPv4Address(n & 0xFFFFFFFF))
    # 6to4 (2002::/16): the IPv4 address is in bits 16..48
    if (n >> 112) == 0x2002:
        return _v4_forbidden(ipaddress.IPv4Address((n >> 80) & 0xFFFFFFFF))
    # Teredo (2001:0::/32): server IPv4 in bits 32..64, client IPv4 inverted in the last 32 bits
    if (n >> 96) == 0x20010000:
        server = ipaddress.IPv4Address((n >> 64) & 0xFFFFFFFF)
        client = ipaddress.IPv4Address((~n) & 0xFFFFFFFF)
        return _v4_forbidden(server) or _v4_forbidden(client)
    return False


@dataclass(frozen=True)
class CheckedUrl:
    url: str
    scheme: str
    host: str
    port: int
    path: str


def check_url(url: str, *, allowed_hosts: frozenset[str] | set[str] | None = None, allowed_ports: tuple[int, ...] = (80, 443)) -> CheckedUrl:
    """Checks the text of a URL before anything is resolved or fetched. Raises PolicyError."""
    if len(url) > 2048 or any(c in url for c in "\r\n\t\x00 "):
        raise PolicyError("the URL is malformed")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise PolicyError("only http and https URLs are allowed")
    if parts.username or parts.password or "@" in (parts.netloc or ""):
        raise PolicyError("URLs with credentials are not allowed")
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise PolicyError("the URL has no host")
    try:
        host.encode("ascii")
    except UnicodeEncodeError:
        raise PolicyError("non-ASCII hosts are not allowed; use the punycode form") from None
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise PolicyError("the port is not valid") from None
    if port not in allowed_ports and not allow_private_network():  # the test override also lifts the port rule (a local fixture server)
        raise PolicyError(f"port {port} is not allowed")
    if allowed_hosts is not None and host not in allowed_hosts:
        raise PolicyError(f"host {host} is not on the allow-list")
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        literal = None
    if literal is not None and not allow_private_network() and is_forbidden_ip(literal):
        raise PolicyError("that address is not reachable by policy")
    # decimal / hex / octal IPv4 spellings (2130706433, 0x7f000001, 0177.0.0.1) are not valid hostnames for us:
    # many resolvers still turn them into 127.0.0.1
    if literal is None and re.fullmatch(r"(0x[0-9a-f]+|[0-9]+)", host.rsplit(".", 1)[-1]):
        raise PolicyError("numeric hosts must be written as a normal IP address")
    return CheckedUrl(url=url, scheme=parts.scheme, host=host, port=port, path=parts.path or "/")


_INTERNAL_SUFFIXES = (".local", ".localhost", ".internal", ".intranet", ".lan", ".corp", ".home", ".home.arpa", ".private")


def check_public_url(url: str) -> CheckedUrl:
    """The stricter check for a website that a user names: a real public DNS name on port 80 or 443.

    IP addresses, single-label names ("intranet") and names that only exist inside networks are refused outright, on
    top of the address checks that run again after DNS resolution and on every redirect. The test override lifts this
    so that a fixture server on 127.0.0.1 can be scanned in tests.
    """
    checked = check_url(url)
    if allow_private_network():
        return checked
    host = checked.host
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    else:
        raise PolicyError("please give the site's domain name, not an IP address")
    if "." not in host or host.endswith(_INTERNAL_SUFFIXES) or host == "localhost":
        raise PolicyError("that name is not a public website address")
    return checked


Resolver = Callable[[str, int], Awaitable[list[str]]]


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [i[4][0] for i in infos]


async def resolve_checked(host: str, port: int, resolver: Resolver = system_resolver) -> list[str]:
    """Resolves a host and refuses it when ANY answer is forbidden. Returns the addresses that are safe to connect to."""
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        addrs = [str(literal)]
    except ValueError:
        try:
            addrs = await resolver(host, port)
        except OSError as exc:
            raise PolicyError(f"could not resolve {host}") from exc
    if not addrs:
        raise PolicyError(f"{host} has no addresses")
    if not allow_private_network():
        for a in addrs:
            if is_forbidden_ip(a.split("%")[0]):
                raise PolicyError(f"{host} resolves to an address that is not reachable by policy")
    return addrs


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """Connects only to addresses that passed the policy, and connects to the address that was checked.

    Resolving and checking, then letting the HTTP library resolve again, would leave a window for DNS rebinding.
    Here the TCP connection goes to the checked IP, while TLS still uses the original host name.
    """

    def __init__(self, resolver: Resolver = system_resolver, inner: httpcore.AsyncNetworkBackend | None = None) -> None:
        self._resolver = resolver
        self._inner = inner or httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
        addrs = await resolve_checked(host, port, self._resolver)
        return await self._inner.connect_tcp(addrs[0], port, timeout=timeout, local_address=local_address, socket_options=socket_options)

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):  # type: ignore[no-untyped-def]
        raise PolicyError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def guarded_transport(resolver: Resolver = system_resolver, inner: httpcore.AsyncNetworkBackend | None = None) -> httpx.AsyncHTTPTransport:
    """An httpx transport whose connections all go through the network policy."""
    transport = httpx.AsyncHTTPTransport(retries=0)
    transport._pool = httpcore.AsyncConnectionPool(  # noqa: SLF001
        network_backend=GuardedBackend(resolver, inner),
        max_connections=8,
        max_keepalive_connections=4,
        keepalive_expiry=5.0,
    )
    return transport
