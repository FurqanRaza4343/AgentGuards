"""Reads a repository tarball into memory. Nothing is ever written to disk and nothing is ever executed.

Because files never touch the filesystem, the classic archive attacks (a path such as ../../etc/cron.d/x, a symlink
that points outside, a hard link, a device file) have nowhere to land. They are still refused and counted, so the
report can say what was skipped and why. Size caps stop decompression bombs: the stream is read in pieces and the
unpacked total is capped, whatever the archive claims about itself.
"""

from __future__ import annotations

import io
import posixpath
import tarfile
from collections import Counter
from dataclasses import dataclass, field

from ..guard.budget import Limits

SKIP_DIRS = {
    ".git", "node_modules", "vendor", "target", "dist", "build", "out", ".next", ".nuxt", "__pycache__", ".venv", "venv",
    ".tox", ".mypy_cache", ".pytest_cache", "coverage", ".gradle", "Pods", "bower_components", "third_party", "site-packages",
}
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".jar", ".war", ".class", ".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".a", ".lib", ".bin", ".woff", ".woff2", ".ttf", ".otf",
    ".eot", ".mp3", ".mp4", ".mov", ".avi", ".wasm", ".pyc", ".pyd", ".db", ".sqlite", ".parquet", ".onnx", ".pt", ".safetensors",
}
# lock files are read by the dependency rules, but are too big and too noisy for the other rules
LOCK_FILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Pipfile.lock", "go.sum", "composer.lock", "Gemfile.lock"}


class ArchiveError(Exception):
    """The archive is not acceptable. The scan stops with a clear message."""


@dataclass
class Corpus:
    """The text files of one repository, by path. Binary and oversized files are not kept."""

    files: dict[str, str] = field(default_factory=dict)
    skipped: Counter[str] = field(default_factory=Counter)
    bytes_read: int = 0

    @property
    def stats(self) -> dict[str, int]:
        return {"files": len(self.files), "bytes": self.bytes_read, "skipped": sum(self.skipped.values())}


def clean_path(name: str, max_depth: int) -> str | None:
    """Returns a safe, normalised relative path, or None when the name must be refused."""
    if "\x00" in name or "\\" in name or name.startswith("/") or len(name) > 400:
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or len(parts) > max_depth:
        return None
    if any(len(p) > 255 or p.endswith(" ") for p in parts):
        return None
    return posixpath.join(*parts)


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:8000]


def read_tarball(data: bytes, limits: Limits | None = None) -> Corpus:
    """Reads a .tar.gz (as GitHub serves it) into a Corpus. Raises ArchiveError on a bad or oversized archive."""
    limits = limits or Limits()
    if len(data) > limits.max_download_bytes:
        raise ArchiveError("the archive is too large")
    corpus = Corpus()
    members = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as tar:
            for member in tar:
                members += 1
                if members > limits.max_files * 2:
                    raise ArchiveError("the archive has too many entries")
                if not member.isreg():
                    corpus.skipped["not a regular file (link, device or directory)"] += 1
                    continue
                # GitHub puts everything under one top folder: drop it
                _, _, rest = member.name.partition("/")
                path = clean_path(rest, limits.max_depth)
                if path is None:
                    corpus.skipped["unsafe or too deep path"] += 1
                    continue
                segments = path.split("/")
                if any(s in SKIP_DIRS for s in segments[:-1]):
                    corpus.skipped["vendored or build folder"] += 1
                    continue
                base = segments[-1]
                ext = posixpath.splitext(base)[1].lower()
                if ext in BINARY_EXTENSIONS:
                    corpus.skipped["binary file"] += 1
                    continue
                is_lock = base in LOCK_FILES
                cap = limits.max_file_bytes * (8 if is_lock else 1)
                if member.size > cap:
                    corpus.skipped["file too large"] += 1
                    continue
                if len(corpus.files) >= limits.max_files:
                    raise ArchiveError("the repository has too many files")
                if corpus.bytes_read + member.size > limits.max_unpacked_bytes:
                    raise ArchiveError("the unpacked repository is too large")
                fh = tar.extractfile(member)
                if fh is None:
                    corpus.skipped["unreadable"] += 1
                    continue
                chunk = fh.read(cap + 1)  # never trust member.size alone
                if len(chunk) > cap:
                    corpus.skipped["file too large"] += 1
                    continue
                if _looks_binary(chunk):
                    corpus.skipped["binary file"] += 1
                    continue
                corpus.bytes_read += len(chunk)
                corpus.files[path] = chunk.decode("utf-8", errors="replace")
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise ArchiveError(f"the archive could not be read: {exc.__class__.__name__}") from exc
    return corpus


def corpus_from_dir(root: str) -> Corpus:
    """Reads a local directory the same way. Used for the demo repository and for the tests, never for user input."""
    import os

    corpus = Corpus()
    limits = Limits()
    base = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            if os.path.islink(full):
                corpus.skipped["not a regular file (link, device or directory)"] += 1
                continue
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            if os.path.splitext(fn)[1].lower() in BINARY_EXTENSIONS:
                corpus.skipped["binary file"] += 1
                continue
            with open(full, "rb") as fh:
                chunk = fh.read(limits.max_file_bytes + 1)
            if len(chunk) > limits.max_file_bytes or _looks_binary(chunk):
                corpus.skipped["file too large or binary"] += 1
                continue
            corpus.bytes_read += len(chunk)
            corpus.files[rel] = chunk.decode("utf-8", errors="replace")
    return corpus
