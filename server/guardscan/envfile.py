"""A tiny .env reader, so the service finds its keys without a new dependency.

It looks for a `.env` file in the working directory and up to four folders above it, reads `NAME=value` lines, and sets
only the variables that are not set yet. Nothing is ever printed or logged: the return value is a list of NAMES.
The file is for local development. In production the platform sets the environment (Cloud Run secrets).
"""

from __future__ import annotations

import os
from pathlib import Path

MAX_BYTES = 64 * 1024


def find_env(start: str | os.PathLike[str] | None = None, levels: int = 4) -> Path | None:
    here = Path(start or os.getcwd()).resolve()
    for folder in [here, *list(here.parents)[:levels]]:
        candidate = folder / ".env"
        if candidate.is_file():
            return candidate
    return None


def parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip()
        if not name.replace("_", "").isalnum() or name[0].isdigit():
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[name] = value
    return out


def load_env(path: str | os.PathLike[str] | None = None) -> list[str]:
    """Sets the variables from the file that are not set yet. Returns the names that were set."""
    file = Path(path) if path else find_env()
    if file is None or not file.is_file() or file.stat().st_size > MAX_BYTES:
        return []
    try:
        values = parse(file.read_text(encoding="utf-8-sig"))
    except OSError:
        return []
    set_now: list[str] = []
    for name, value in values.items():
        if value and name not in os.environ:
            os.environ[name] = value
            set_now.append(name)
    return set_now


def gemini_keys() -> list[str]:
    """Every configured Gemini key, in order: GEMINI_API_KEY, GEMINI_API_KEY2, ..., then GOOGLE_API_KEY. No duplicates."""
    names = ["GEMINI_API_KEY", *[f"GEMINI_API_KEY{i}" for i in range(2, 6)], "GOOGLE_API_KEY"]
    keys: list[str] = []
    for n in names:
        v = os.environ.get(n, "").strip()
        if v and v not in keys:
            keys.append(v)
    return keys
