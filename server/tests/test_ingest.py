import io
import tarfile

import httpx
import pytest

from guardscan.guard.budget import Limits
from guardscan.tools.extract import ArchiveError, clean_path, read_tarball
from guardscan.tools.github import FetchError, GithubSource, RepoRef, parse_repo_url


# ------------------------------------------------------------------ parsing the URL

@pytest.mark.parametrize(
    "text,owner,repo",
    [
        ("https://github.com/h4ckf0r0day/obscura", "h4ckf0r0day", "obscura"),
        ("github.com/owner/repo", "owner", "repo"),
        ("https://github.com/owner/repo.git", "owner", "repo"),
        ("https://github.com/owner/repo/", "owner", "repo"),
        ("https://www.github.com/owner/repo/tree/main/src", "owner", "repo"),
        ("http://github.com/owner/some.repo-name_1", "owner", "some.repo-name_1"),
    ],
)
def test_good_repository_urls(text: str, owner: str, repo: str) -> None:
    assert parse_repo_url(text) == RepoRef(owner, repo)


@pytest.mark.parametrize(
    "text",
    [
        "", "   ", "github.com", "github.com/owner", "https://gitlab.com/owner/repo", "git@github.com:owner/repo.git",
        "https://github.com.evil.example/owner/repo", "https://evil.example/github.com/owner/repo",
        "https://user:pass@github.com/owner/repo", "https://github.com:8443/owner/repo", "ftp://github.com/owner/repo",
        "https://github.com/owner/../repo", "https://github.com/-bad/repo", "https://github.com/owner/re po",
        "https://github.com/owner/repo\nHost: x", "https://github.com/owner/repo/settings/keys", "https://127.0.0.1/owner/repo",
        "https://github.com/" + "a" * 300 + "/repo",
    ],
)
def test_bad_repository_urls_are_refused(text: str) -> None:
    with pytest.raises(FetchError):
        parse_repo_url(text)


# ------------------------------------------------------------------ the tarball

def make_tar(entries: list[tuple[str, bytes | None, str]]) -> bytes:
    """entries: (name, data, kind). kind is file, symlink, hardlink, device or dir."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "file":
                info.size = len(data or b"")
                tar.addfile(info, io.BytesIO(data or b""))
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/passwd"
                tar.addfile(info)
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "repo-abc/app.py"
                tar.addfile(info)
            elif kind == "device":
                info.type = tarfile.CHRTYPE
                tar.addfile(info)
            elif kind == "dir":
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
    return buf.getvalue()


def test_reads_text_files_and_drops_the_top_folder() -> None:
    corpus = read_tarball(make_tar([
        ("repo-abc", None, "dir"),
        ("repo-abc/app.py", b"print('hi')\n", "file"),
        ("repo-abc/src/lib/util.js", b"export const x = 1\n", "file"),
    ]))
    assert set(corpus.files) == {"app.py", "src/lib/util.js"}
    assert corpus.files["app.py"] == "print('hi')\n"
    assert corpus.stats["files"] == 2


def test_refuses_traversal_absolute_paths_links_and_devices_but_keeps_scanning() -> None:
    corpus = read_tarball(make_tar([
        ("repo-abc/ok.txt", b"fine", "file"),
        ("repo-abc/../../etc/cron.d/evil", b"* * * * * root x", "file"),
        ("repo-abc/a/../../b.txt", b"x", "file"),
        ("repo-abc/link", None, "symlink"),
        ("repo-abc/hard", None, "hardlink"),
        ("repo-abc/dev", None, "device"),
        ("repo-abc/back\\slash.txt", b"x", "file"),
    ]))
    assert list(corpus.files) == ["ok.txt"]
    assert corpus.skipped["not a regular file (link, device or directory)"] == 3
    assert corpus.skipped["unsafe or too deep path"] == 3


def test_skips_vendored_folders_binaries_and_large_files() -> None:
    big = b"a" * (1024 * 1024 + 10)
    corpus = read_tarball(make_tar([
        ("r/node_modules/pkg/index.js", b"x", "file"),
        ("r/vendor/lib.rs", b"x", "file"),
        ("r/img.png", b"\x89PNG", "file"),
        ("r/data.txt", b"has\x00null", "file"),
        ("r/big.txt", big, "file"),
        ("r/src/ok.rs", b"fn main() {}", "file"),
        ("r/Cargo.lock", b"[[package]]\n" * 50000, "file"),  # a lock file may be larger
    ]))
    assert set(corpus.files) == {"src/ok.rs", "Cargo.lock"}
    assert corpus.skipped["vendored or build folder"] == 2
    assert corpus.skipped["binary file"] == 2
    assert corpus.skipped["file too large"] == 1


def test_a_decompression_bomb_is_stopped_by_the_unpacked_cap() -> None:
    bomb = make_tar([("r/zeros.txt", b"0" * (3 * 1024 * 1024), "file")])
    assert len(bomb) < 20_000  # tiny on the wire, 3 MB unpacked
    with pytest.raises(ArchiveError, match="too large"):
        read_tarball(bomb, Limits(max_file_bytes=10 * 1024 * 1024, max_unpacked_bytes=1024 * 1024))


def test_too_many_files_and_oversized_downloads_are_refused() -> None:
    many = make_tar([(f"r/f{i}.txt", b"x", "file") for i in range(30)])
    with pytest.raises(ArchiveError, match="too many"):
        read_tarball(many, Limits(max_files=10))
    with pytest.raises(ArchiveError, match="too large"):
        read_tarball(many, Limits(max_download_bytes=10))


def test_garbage_is_not_an_archive() -> None:
    with pytest.raises(ArchiveError):
        read_tarball(b"this is not a tarball at all" * 10)


def test_deep_paths_are_refused() -> None:
    deep = "/".join(["d"] * 40) + "/x.txt"
    corpus = read_tarball(make_tar([(f"r/{deep}", b"x", "file")]))
    assert corpus.files == {}


def test_clean_path() -> None:
    assert clean_path("a/./b//c.txt", 24) == "a/b/c.txt"
    for bad in ["../x", "a/../../x", "/abs", "a\\b", "", ".", "a/" + "b" * 300, "x\x00y"]:
        assert clean_path(bad, 24) is None


# ------------------------------------------------------------------ the GitHub source (no network: a mock transport)

SHA = "a" * 40


def source_for(handler) -> GithubSource:  # type: ignore[no-untyped-def]
    return GithubSource(client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False))


def happy(request: httpx.Request) -> httpx.Response:
    u = str(request.url)
    if u.endswith("/repos/o/r"):
        return httpx.Response(200, json={"private": False, "size": 10, "default_branch": "main"})
    if u.endswith("/commits/main"):
        return httpx.Response(200, json={"sha": SHA})
    if u == f"https://codeload.github.com/o/r/tar.gz/{SHA}":
        return httpx.Response(200, content=b"TARBYTES")
    return httpx.Response(500)


async def test_fetch_happy_path() -> None:
    sha, data = await source_for(happy).fetch(RepoRef("o", "r"), Limits())
    assert sha == SHA and data == b"TARBYTES"


async def test_fetch_follows_a_redirect_only_to_an_allowed_host() -> None:
    def redirecting(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if request.url.host == "codeload.github.com" and "/tar.gz/" in u:
            return httpx.Response(200, content=b"OK")
        if u.endswith("/tar.gz/" + SHA) or "api.github.com/tarball" in u:
            return httpx.Response(500)
        if u.endswith("/repos/o/r"):
            return httpx.Response(200, json={"private": False, "size": 1, "default_branch": "main"})
        if u.endswith("/commits/main"):
            return httpx.Response(200, json={"sha": SHA})
        return httpx.Response(500)

    sha, data = await source_for(redirecting).fetch(RepoRef("o", "r"), Limits())
    assert data == b"OK"

    def evil(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/repos/o/r"):
            return httpx.Response(302, headers={"location": "https://evil.example/steal"})
        return httpx.Response(500)

    with pytest.raises(FetchError, match="network policy"):
        await source_for(evil).fetch(RepoRef("o", "r"), Limits())

    def to_metadata(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})

    with pytest.raises(FetchError, match="network policy"):
        await source_for(to_metadata).fetch(RepoRef("o", "r"), Limits())


async def test_fetch_stops_on_a_redirect_loop() -> None:
    def loop(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://api.github.com/loop"})

    with pytest.raises(FetchError, match="redirects"):
        await source_for(loop).fetch(RepoRef("o", "r"), Limits())


@pytest.mark.parametrize(
    "status,body,message",
    [(404, {}, "not found"), (403, {}, "rate limiting"), (429, {}, "rate limiting"), (500, {}, "answered 500"), (200, {"private": True}, "private")],
)
async def test_fetch_errors_are_clear(status: int, body: dict, message: str) -> None:
    def h(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    with pytest.raises(FetchError, match=message):
        await source_for(h).fetch(RepoRef("o", "r"), Limits())


async def test_fetch_refuses_a_huge_repository_before_downloading_it() -> None:
    def h(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"private": False, "size": 10_000_000, "default_branch": "main"})

    with pytest.raises(FetchError, match="too large"):
        await source_for(h).fetch(RepoRef("o", "r"), Limits(max_download_bytes=1024 * 1024))


async def test_fetch_aborts_a_download_that_exceeds_the_limit() -> None:
    def h(request: httpx.Request) -> httpx.Response:
        if request.url.host == "codeload.github.com":
            return httpx.Response(200, content=b"x" * 5000)
        if str(request.url).endswith("/repos/o/r"):
            return httpx.Response(200, json={"private": False, "size": 0, "default_branch": "main"})  # the metadata understates the size
        return happy(request)

    with pytest.raises(FetchError, match="larger than the limit"):
        await source_for(h).fetch(RepoRef("o", "r"), Limits(max_download_bytes=1000))


async def test_a_token_is_sent_only_when_given() -> None:
    seen: list[str | None] = []

    def h(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        return happy(request)

    await source_for(h).fetch(RepoRef("o", "r"), Limits())
    assert set(seen) == {None}
    src = GithubSource(client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(h), follow_redirects=False), token="t0k3n")
    await src.fetch(RepoRef("o", "r"), Limits())
    assert "Bearer t0k3n" in seen
