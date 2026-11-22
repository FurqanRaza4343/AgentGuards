"""Fetching a public GitHub repository: one tarball, from two fixed hosts, through the network policy."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..guard.budget import Limits
from ..guard.netpolicy import PolicyError, check_url, guarded_transport

API_HOST = "api.github.com"
CODELOAD_HOST = "codeload.github.com"
ALLOWED_HOSTS = frozenset({API_HOST, CODELOAD_HOST})

_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_SHA = re.compile(r"^[0-9a-f]{40}$")


class FetchError(Exception):
    """The repository could not be fetched. The message is safe to show."""


@dataclass(frozen=True)
class RepoRef:
    owner: str
    repo: str

    @property
    def full(self) -> str:
        return f"{self.owner}/{self.repo}"


def parse_repo_url(text: str) -> RepoRef:
    """Accepts github.com/owner/repo (with or without https://, .git, a trailing slash, /tree/... or /blob/...)."""
    t = text.strip()
    if not t or len(t) > 300 or any(c in t for c in "\r\n\t\x00 "):
        raise FetchError("that does not look like a GitHub repository URL")
    if "://" not in t:
        t = "https://" + t
    try:
        checked = check_url(t, allowed_hosts={"github.com", "www.github.com"})
    except PolicyError as exc:
        raise FetchError(f"only github.com repositories are supported ({exc})") from exc
    parts = [p for p in checked.path.split("/") if p]
    if len(parts) < 2:
        raise FetchError("the URL must name a repository, like github.com/owner/repo")
    owner, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not _OWNER.match(owner) or not _REPO.match(repo) or repo in {".", ".."}:
        raise FetchError("the owner or repository name is not valid")
    if len(parts) > 2 and parts[2] not in {"tree", "blob", "pull", "issues", "commit", "commits", "releases", "wiki", "actions"}:
        raise FetchError("the URL must name a repository, like github.com/owner/repo")
    return RepoRef(owner, repo)


class RepoSource(Protocol):
    async def fetch(self, ref: RepoRef, limits: Limits) -> tuple[str, bytes]:
        """Returns (commit sha, tar.gz bytes)."""
        ...


class GithubSource:
    """The real source. Only the two GitHub hosts are reachable, every hop is checked, and the body is size-capped."""

    def __init__(self, client_factory=None, token: str | None = None) -> None:  # type: ignore[no-untyped-def]
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(transport=guarded_transport(), timeout=httpx.Timeout(20.0, connect=8.0), follow_redirects=False))
        self._token = token

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/vnd.github+json", "User-Agent": "agentguard-scanner/1.0 (+defensive code review)", "X-GitHub-Api-Version": "2022-11-28"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    async def _get(self, client: httpx.AsyncClient, url: str, *, stream_limit: int | None = None) -> httpx.Response:
        """GET with manual redirects, so every hop goes back through the policy and the allow-list."""
        for _hop in range(4):
            try:
                check_url(url, allowed_hosts=ALLOWED_HOSTS)
            except PolicyError as exc:
                raise FetchError(f"refused by the network policy: {exc}") from exc
            try:
                async with client.stream("GET", url, headers=self._headers()) as resp:
                    if resp.status_code in {301, 302, 303, 307, 308}:
                        location = resp.headers.get("location", "")
                        if not location:
                            raise FetchError("GitHub sent a redirect without a location")
                        url = str(httpx.URL(url).join(location))
                        continue
                    body = bytearray()
                    async for chunk in resp.aiter_bytes():
                        body.extend(chunk)
                        if stream_limit is not None and len(body) > stream_limit:
                            raise FetchError("the repository is larger than the limit")
                    # the body is already decoded, so the encoding and length headers must not be carried over
                    headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}]
                    return httpx.Response(resp.status_code, headers=headers, content=bytes(body), request=resp.request)
            except PolicyError as exc:
                raise FetchError(f"refused by the network policy: {exc}") from exc
            except httpx.HTTPError as exc:
                raise FetchError(f"could not reach GitHub ({exc.__class__.__name__})") from exc
        raise FetchError("too many redirects")

    async def fetch(self, ref: RepoRef, limits: Limits) -> tuple[str, bytes]:
        async with self._client_factory() as client:
            meta = await self._get(client, f"https://{API_HOST}/repos/{ref.owner}/{ref.repo}", stream_limit=1_000_000)
            if meta.status_code == 404:
                raise FetchError("that repository was not found, or it is private (private repositories are not supported)")
            if meta.status_code in {403, 429}:
                raise FetchError("GitHub is rate limiting this request, try again later")
            if meta.status_code != 200:
                raise FetchError(f"GitHub answered {meta.status_code}")
            info = meta.json()
            if info.get("private"):
                raise FetchError("private repositories are not supported")
            size_kb = int(info.get("size", 0))
            if size_kb * 1024 > limits.max_download_bytes * 4:
                raise FetchError("the repository is too large to scan")
            branch = str(info.get("default_branch") or "HEAD")
            ref_resp = await self._get(client, f"https://{API_HOST}/repos/{ref.owner}/{ref.repo}/commits/{branch}", stream_limit=2_000_000)
            sha = ref_resp.json().get("sha", "") if ref_resp.status_code == 200 else ""
            if not _SHA.match(sha):
                raise FetchError("could not read the latest commit")
            tar = await self._get(client, f"https://{CODELOAD_HOST}/{ref.owner}/{ref.repo}/tar.gz/{sha}", stream_limit=limits.max_download_bytes)
            if tar.status_code != 200:
                raise FetchError(f"could not download the repository ({tar.status_code})")
            return sha, tar.content


class DirSource:
    """A local directory per repository, for tests and the demo. Enabled only through an environment variable."""

    def __init__(self, root: str, commit: str = "0" * 40, *, exact_path: str | None = None) -> None:
        self._root = root
        self._commit = commit
        self._exact = exact_path  # a folder of any name, for scanning a checkout (the CLI and CI)

    async def fetch(self, ref: RepoRef, limits: Limits) -> tuple[str, bytes]:  # pragma: no cover - not used, the pipeline reads the directory
        raise FetchError("DirSource is read directly by the pipeline")

    def path_for(self, ref: RepoRef) -> str:
        import os

        path = self._exact or os.path.join(self._root, f"{ref.owner}__{ref.repo}")
        if not os.path.isdir(path):
            raise FetchError("that repository was not found")
        return path

    @property
    def commit(self) -> str:
        return self._commit
