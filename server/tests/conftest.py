"""Tests must not depend on the machine they run on: no key from a .env, no search server, no real app built on import."""

from __future__ import annotations

import os

os.environ["AGENTGUARD_CREATE_APP"] = "0"  # importing guardscan.api must not build the real app or read a .env file
for _name in list(os.environ):
    if _name.startswith(("GEMINI_API_KEY", "GOOGLE_API_KEY")) or _name in {"SEARXNG_URL", "GITHUB_TOKEN", "AGENTGUARD_KILL_SWITCH", "AGENTGUARD_ALLOW_PRIVATE_NETWORK"}:
        del os.environ[_name]
