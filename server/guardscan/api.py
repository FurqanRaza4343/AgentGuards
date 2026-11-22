"""The HTTP interface. Two kinds of run, both streamed as Server-Sent Events, plus a health check and the pre-baked demos.

    POST /api/scan     {"url": "github.com/owner/repo"}                      a public GitHub repository
    POST /api/assess   {"kind": "site", "url": "example.com"}                 a website, read passively
                       {"kind": "profile", "text": "...", "role": "..."}      a profile that the person pasted

Run:  uvicorn guardscan.api:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .assess.nova import AdkNova, NullNova
from .assess.orchestrator import AssessServices, assess
from .assess.search import SearxClient
from .coach import AdkCoach, NullCoach
from .envfile import gemini_keys, load_env
from .llm import backup_configured
from .guard.budget import KillSwitch, RateLimiter
from .pipeline import Services, scan
from .tools.github import DirSource, FetchError, GithubSource
from .tools.osv import OsvClient
from .tools.web import parse_site_input

DEMO_DIR = Path(__file__).resolve().parent.parent / "demo"
DEMO_FILE = DEMO_DIR / "demo-report.json"
DEMO_FILES = {"repo": DEMO_FILE, "site": DEMO_DIR / "demo-site-report.json", "profile": DEMO_DIR / "demo-profile-report.json"}
BODY_LIMIT = 4096
ASSESS_BODY_LIMIT = 64 * 1024

STABLE_PREFIXES = ("/fonts/", "/models/")

API_CSP = "default-src 'none'; frame-ancestors 'none'"
PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"


class ScanRequest(BaseModel):
    url: str = Field(min_length=3, max_length=300)


class AssessRequest(BaseModel):
    kind: Literal["site", "profile"]
    url: str | None = Field(default=None, max_length=300)
    text: str | None = Field(default=None, max_length=25_000)
    role: str | None = Field(default=None, max_length=120)


def default_assess_services(kill: KillSwitch | None = None) -> AssessServices:
    """Gemini for Nova when a key is set, SearXNG when SEARXNG_URL is set, and a short pause between the visible steps of a profile run."""
    kill = kill or KillSwitch()
    try:
        pace = float(os.environ.get("AGENTGUARD_PACE", "0.45"))
    except ValueError:
        pace = 0.45
    return AssessServices(search=SearxClient.from_env(), nova=AdkNova(kill) if (gemini_keys() or backup_configured()) else NullNova(), kill=kill, pace=max(0.0, min(pace, 2.0)))


def default_services() -> Services:
    """Real GitHub and OSV. A local directory replaces GitHub only when explicitly asked, for tests and the demo."""
    kill = KillSwitch()
    coach = AdkCoach(kill) if (gemini_keys() or backup_configured()) else NullCoach()
    svc = Services(source=GithubSource(token=os.environ.get("GITHUB_TOKEN") or None), osv=OsvClient(), coach=coach, kill=kill)
    test_dir = os.environ.get("AGENTGUARD_TEST_SOURCE_DIR")
    if test_dir:
        if os.environ.get("AGENTGUARD_ENV", "").lower() == "production":
            raise RuntimeError("AGENTGUARD_TEST_SOURCE_DIR must not be set in production")
        svc.dir_source = DirSource(test_dir, "c" * 40)
    return svc


def create_app(services: Services | None = None, *, assess_services: AssessServices | None = None, rate_per_hour: int | None = None, max_concurrent: int | None = None, static_dir: str | None = None) -> FastAPI:
    app = FastAPI(title="AgentGuard scanner", docs_url=None, redoc_url=None, openapi_url=None)
    svc = services or default_services()
    asvc = assess_services or default_assess_services(svc.kill)
    limiter = RateLimiter(rate_per_hour or int(os.environ.get("AGENTGUARD_RATE_PER_HOUR", "6")))
    host_limiter = RateLimiter(int(os.environ.get("AGENTGUARD_HOST_RATE_PER_HOUR", "3")))  # one website may be read only a few times an hour, whoever asks
    gate = asyncio.Semaphore(max_concurrent or int(os.environ.get("AGENTGUARD_MAX_CONCURRENT", "2")))
    trust_proxy = os.environ.get("AGENTGUARD_TRUST_PROXY", "").lower() in {"1", "true", "yes"}

    try:
        proxy_hops = max(1, int(os.environ.get("AGENTGUARD_PROXY_HOPS", "1")))
    except ValueError:
        proxy_hops = 1

    # A header that the platform in front sets itself and overwrites if a client sends it (Cloudflare's CF-Connecting-IP, for example).
    client_ip_header = os.environ.get("AGENTGUARD_CLIENT_IP_HEADER", "").strip().lower()
    debug_client = os.environ.get("AGENTGUARD_DEBUG_CLIENT", "") == "1"

    def client_id(request: Request) -> str:
        """The client address for the rate limits. Behind a proxy it is, in this order: the platform's own header if one is
        configured, else the entry that the proxy itself added, the one `proxy_hops` places from the END of X-Forwarded-For.
        The first entry is whatever the client wrote and can be forged."""
        if trust_proxy:
            if client_ip_header:
                value = request.headers.get(client_ip_header, "").strip()
                if value:
                    return value[:64]
            parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
            if parts:
                return parts[-proxy_hops if len(parts) >= proxy_hops else 0][:64]
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def secure(request: Request, call_next):  # type: ignore[no-untyped-def]
        length = request.headers.get("content-length")
        limit = ASSESS_BODY_LIMIT if request.url.path == "/api/assess" else BODY_LIMIT
        if length and length.isdigit() and int(length) > limit:
            return JSONResponse({"message": "The request is too large."}, status_code=413, headers={"Content-Security-Policy": API_CSP})
        response = await call_next(request)
        is_api = request.url.path.startswith("/api/")
        response.headers["Content-Security-Policy"] = API_CSP if is_api else PAGE_CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if is_api:
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"  # Vite puts a content hash in these names
        elif request.url.path.startswith(STABLE_PREFIXES):
            response.headers["Cache-Control"] = "public, max-age=86400"  # fonts and models keep their names
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/health")
    async def health(request: Request) -> dict[str, object]:
        out: dict[str, object] = {
            "ok": True,
            "model": isinstance(svc.coach, AdkCoach) and svc.coach.available,
            "search": asvc.search is not None,
            "testSource": svc.dir_source is not None,
        }
        if debug_client:  # switched on only while checking how a new platform forwards client addresses: counts and flags, never an address
            h = request.headers
            out["clientDebug"] = {
                "xffEntries": len([p for p in h.get("x-forwarded-for", "").split(",") if p.strip()]),
                "cfConnectingIp": bool(h.get("cf-connecting-ip")),
                "trueClientIp": bool(h.get("true-client-ip")),
                "xRealIp": bool(h.get("x-real-ip")),
            }
        return out

    async def _demo(which: str):  # type: ignore[no-untyped-def]
        path = DEMO_FILE if which == "repo" else DEMO_FILES[which]
        if not path.exists():
            return JSONResponse({"message": "No demo report has been baked yet."}, status_code=404)
        return FileResponse(path, media_type="application/json")

    @app.get("/api/demo")
    async def demo():  # type: ignore[no-untyped-def]
        return await _demo("repo")

    @app.get("/api/demo/{kind}")
    async def demo_kind(kind: Literal["site", "profile"]):  # type: ignore[no-untyped-def]
        return await _demo(kind)

    @app.post("/api/scan")
    async def scan_endpoint(body: ScanRequest, request: Request):  # type: ignore[no-untyped-def]
        if not limiter.allow(client_id(request)):
            return JSONResponse({"message": "Too many scans from this address. Try again later, or play the demo."}, status_code=429, headers={"Retry-After": "3600"})
        if gate.locked():
            return JSONResponse({"message": "The scanner is busy. Try again in a minute."}, status_code=503, headers={"Retry-After": "60"})

        async def stream() -> AsyncIterator[str]:
            async with gate:
                async for kind, data in scan(body.url, svc):
                    yield f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.post("/api/assess")
    async def assess_endpoint(body: AssessRequest, request: Request):  # type: ignore[no-untyped-def]
        if not limiter.allow(client_id(request)):
            return JSONResponse({"message": "Too many runs from this address. Try again later, or play the demo."}, status_code=429, headers={"Retry-After": "3600"})
        if body.kind == "site":
            try:
                host = urlsplit(parse_site_input(body.url or "")).hostname or ""
            except FetchError:
                host = ""  # the run reports the problem with the address itself
            if host and not host_limiter.allow(host):
                return JSONResponse({"message": f"{host} was read several times in the last hour. Please wait, or play the demo."}, status_code=429, headers={"Retry-After": "3600"})
        if gate.locked():
            return JSONResponse({"message": "The service is busy. Try again in a minute."}, status_code=503, headers={"Retry-After": "60"})

        async def stream() -> AsyncIterator[str]:
            async with gate:
                async for kind, data in assess(body.kind, {"url": body.url, "text": body.text, "role": body.role}, asvc):
                    yield f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    static = static_dir or os.environ.get("AGENTGUARD_STATIC_DIR")
    if static and os.path.isdir(static):
        app.mount("/", StaticFiles(directory=static, html=True), name="site")
    return app


if os.environ.get("AGENTGUARD_CREATE_APP", "1") == "1":
    load_env()  # a local .env, if there is one; never overrides what the platform already set
    app = create_app()
else:
    app = None  # type: ignore[assignment]
