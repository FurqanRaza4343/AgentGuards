import ipaddress

import httpcore
import httpx
import pytest

from guardscan.guard.netpolicy import (
    PolicyError,
    check_url,
    guarded_transport,
    is_forbidden_ip,
    resolve_checked,
)

FORBIDDEN = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200", "100.127.255.255",
    "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "ff02::1", "100::1", "2001:db8::1", "3fff::1",
    "64:ff9b:1::1",
    # IPv4 hidden inside IPv6
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::7f00:1",          # NAT64 of 127.0.0.1
    "64:ff9b::a9fe:a9fe",       # NAT64 of 169.254.169.254
    "2002:7f00:1::",            # 6to4 of 127.0.0.1
    "2002:a9fe:a9fe::1",        # 6to4 of 169.254.169.254
    "2001:0:7f00:1::1",         # Teredo, server is 127.0.0.1
    "2001:0:4136:e378:8000:63bf:80ff:fffe",  # Teredo, client inverts to 127.0.0.1
]

ALLOWED = [
    "8.8.8.8", "1.1.1.1", "140.82.112.3", "185.199.108.153", "192.0.0.9", "192.0.0.10", "172.15.255.255", "172.32.0.1",
    "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "11.0.0.1",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1",
]


@pytest.mark.parametrize("ip", FORBIDDEN)
def test_forbidden_ranges(ip: str) -> None:
    assert is_forbidden_ip(ip), ip


@pytest.mark.parametrize("ip", ALLOWED)
def test_public_addresses_are_allowed(ip: str) -> None:
    assert not is_forbidden_ip(ip), ip


def test_accepts_ip_objects() -> None:
    assert is_forbidden_ip(ipaddress.ip_address("10.1.1.1"))
    assert not is_forbidden_ip(ipaddress.ip_address("8.8.4.4"))


# ------------------------------------------------------------------ URL text

@pytest.mark.parametrize(
    "url",
    [
        "ftp://github.com/x",
        "file:///etc/passwd",
        "gopher://github.com",
        "https://user:pass@github.com/x",
        "https://github.com@evil.example/x",
        "https://github.com:8443/x",
        "https:///nohost",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::ffff:169.254.169.254]/",
        "http://2130706433/",          # decimal spelling of 127.0.0.1
        "http://0x7f000001/",
        "https://github.com/x\r\nHost: evil",
        "https://github.com/ x",
        "https://bücher.example/",
        "https://example.com/" + "a" * 3000,
    ],
)
def test_bad_urls_are_refused(url: str) -> None:
    with pytest.raises(PolicyError):
        check_url(url)


def test_allow_list_is_enforced() -> None:
    allowed = {"api.github.com", "codeload.github.com"}
    ok = check_url("https://api.github.com/repos/a/b/tarball", allowed_hosts=allowed)
    assert ok.host == "api.github.com" and ok.port == 443
    with pytest.raises(PolicyError):
        check_url("https://evil.example/", allowed_hosts=allowed)
    with pytest.raises(PolicyError):
        check_url("https://api.github.com.evil.example/", allowed_hosts=allowed)
    # a trailing dot and capital letters do not get past the list
    assert check_url("https://API.GitHub.com./x", allowed_hosts=allowed).host == "api.github.com"


def test_override_exists_only_through_the_explicit_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(PolicyError):
        check_url("http://127.0.0.1:80/")
    monkeypatch.setenv("AGENTGUARD_ALLOW_PRIVATE_NETWORK", "1")
    assert check_url("http://127.0.0.1:80/").host == "127.0.0.1"


# ------------------------------------------------------------------ resolution

async def test_resolution_refuses_a_host_that_resolves_to_a_private_address() -> None:
    async def rebinding(host: str, port: int) -> list[str]:
        return ["93.184.216.34", "127.0.0.1"]  # one good answer and one bad: the whole host is refused

    with pytest.raises(PolicyError, match="not reachable"):
        await resolve_checked("example.com", 443, rebinding)


async def test_resolution_accepts_public_answers_and_literal_ips() -> None:
    async def fine(host: str, port: int) -> list[str]:
        return ["140.82.112.3"]

    assert await resolve_checked("github.com", 443, fine) == ["140.82.112.3"]
    assert await resolve_checked("8.8.8.8", 443, fine) == ["8.8.8.8"]
    with pytest.raises(PolicyError):
        await resolve_checked("10.0.0.5", 443, fine)


async def test_resolution_failure_and_empty_answers_are_refused() -> None:
    async def broken(host: str, port: int) -> list[str]:
        raise OSError("no such host")

    async def empty(host: str, port: int) -> list[str]:
        return []

    with pytest.raises(PolicyError):
        await resolve_checked("nope.example", 443, broken)
    with pytest.raises(PolicyError):
        await resolve_checked("nope.example", 443, empty)


# ------------------------------------------------------------------ the transport

async def test_transport_never_connects_to_a_private_address() -> None:
    """The HTTP client must stop at the policy, before any connection is made."""
    connects: list[str] = []

    class Recording(httpcore.AsyncMockBackend):
        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
            connects.append(host)
            return await super().connect_tcp(host, port, timeout=timeout, local_address=local_address, socket_options=socket_options)

    async def rebinding(host: str, port: int) -> list[str]:
        return ["169.254.169.254"]

    transport = guarded_transport(rebinding, Recording([b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(PolicyError):
            await client.get("http://metadata.example/latest/meta-data/")
    assert connects == []


async def test_transport_connects_to_the_address_that_was_checked() -> None:
    """DNS rebinding: the connection goes to the IP that passed the check, not to a second resolution."""
    connects: list[str] = []

    class Recording(httpcore.AsyncMockBackend):
        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
            connects.append(host)
            return await super().connect_tcp(host, port, timeout=timeout, local_address=local_address, socket_options=socket_options)

    async def resolver(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    transport = guarded_transport(resolver, Recording([b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]))
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.get("http://example.com/")
    assert response.status_code == 200 and response.text == "ok"
    assert connects == ["93.184.216.34"]
