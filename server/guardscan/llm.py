"""One place that talks to Gemini through the Agent Development Kit.

Every caller (the repository Coach and the website/profile orchestrator) goes through `run_structured`: an `LlmAgent`
with no tools and an `output_schema`, so the model can only answer in the shape we ask for.

Fallback, because the free tier has small quotas that are counted per model AND per key: the attempts are (model, key)
pairs, in order. With the default chain, `gemini-2.5-flash` is tried with every key, then `gemini-2.5-flash-lite` (a separate
quota) with every key. A pair that answered "quota" is skipped for a few minutes, so a run does not pay for the same
failure again. The whole thing has a deadline, so a run never waits long for a model that is not going to answer.

If nothing in that chain answers and the operator configured a backup provider (AI_API_KEY, AI_BASE_URL, AI_MODEL: any
OpenAI-compatible API), it is asked last. The caller is told which one answered ("gemini" or "backup"), and what the
interface shows people says so: text from the backup is never presented as Gemini's.

Nothing here logs a key or a prompt.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from .guard.inject import SYSTEM_RULES

_lock = asyncio.Lock()  # the ADK reads the key from the environment, so one call at a time may change it

DEFAULT_MODELS = ("gemini-2.5-flash", "gemini-2.5-flash-lite")
COOLDOWN_SECONDS = 300.0  # a (model, key) pair that said "quota" is left alone for this long
_cooldown: dict[tuple[str, str], float] = {}

# The ADK and the Gemini client print whole tracebacks for a failed call, and an error body can echo part of the prompt
# (which holds a person's own text). Their loggers are silenced; the failure is reported as one short line by the caller.
for _name in ("google_adk", "google_genai", "google.adk", "google.genai"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)


class LlmUnavailable(Exception):
    """No model answered. Not an error for the caller: it falls back to its templates."""


def model_chain() -> list[str]:
    """AGENTGUARD_MODELS (comma separated) wins; AGENTGUARD_MODEL (one name) goes first if it is set; the default is flash, then flash-lite."""
    listed = [m.strip() for m in os.environ.get("AGENTGUARD_MODELS", "").split(",") if m.strip()]
    first = os.environ.get("AGENTGUARD_MODEL", "").strip()
    chain = listed or list(DEFAULT_MODELS)
    if first and first not in chain:
        chain.insert(0, first)
    return chain


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:12]  # never the key itself


def _is_quota(exc: BaseException) -> bool:
    text = f"{exc.__class__.__name__} {exc}"
    return "RESOURCE_EXHAUSTED" in text or "ResourceExhausted" in text or "429" in text


async def _run_once(name: str, instruction: str, prompt: str, schema: type[BaseModel], model: str, key: str) -> str:
    try:
        from google.adk.agents import LlmAgent
        from google.adk.models.google_llm import Gemini
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.genai import types
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise LlmUnavailable("the Agent Development Kit is not installed") from exc

    async with _lock:
        os.environ["GOOGLE_API_KEY"] = key
        agent = LlmAgent(
            name=name,
            # one retry for a passing outage; a quota answer is not retried, the next (model, key) pair is tried instead
            model=Gemini(model=model, retry_options=types.HttpRetryOptions(attempts=2)),
            instruction=instruction,
            output_schema=schema,  # a schema, so no tools and no free text
            disallow_transfer_to_parent=True,
            disallow_transfer_to_peers=True,
        )
        service = InMemorySessionService()
        runner = Runner(agent=agent, app_name="agentguard", session_service=service)
        session = uuid.uuid4().hex
        await service.create_session(app_name="agentguard", user_id="scan", session_id=session)
        message = types.Content(role="user", parts=[types.Part(text=prompt)])
        text = ""
        async for event in runner.run_async(user_id="scan", session_id=session, new_message=message):
            if event.is_final_response() and event.content and event.content.parts:
                text = event.content.parts[0].text or ""
        return text


# ------------------------------------------------------------------ an optional backup provider (any OpenAI-compatible API)

def backup_configured() -> bool:
    """True when AI_API_KEY, AI_BASE_URL and AI_MODEL are all set and the address is a plain http(s) address."""
    key, base, model = (os.environ.get(n, "").strip() for n in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL"))
    parts = urlsplit(base)
    return bool(key and model and parts.scheme in {"http", "https"} and parts.hostname and not parts.username)


def _backup_client() -> httpx.AsyncClient:  # replaced in tests
    return httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=False)


def _fit(value: Any, node: dict[str, Any], defs: dict[str, Any]) -> Any:
    """Cuts strings and lists down to the limits the schema states. Another provider has no way to be told these limits as firmly as
    Gemini, and an answer that is a few characters too long should be shortened, not thrown away."""
    if "$ref" in node:
        node = defs.get(node["$ref"].rsplit("/", 1)[-1], {})
    if "anyOf" in node:  # an optional field: use the branch that is not null
        node = next((n for n in node["anyOf"] if n.get("type") != "null"), {})
    if isinstance(value, str):
        limit = node.get("maxLength")
        return value[:limit] if isinstance(limit, int) else value
    if isinstance(value, list):
        limit = node.get("maxItems")
        items = value[:limit] if isinstance(limit, int) else value
        return [_fit(v, node.get("items", {}), defs) for v in items]
    if isinstance(value, dict):
        props = node.get("properties", {})
        return {k: _fit(v, props.get(k, {}), defs) for k, v in value.items()}
    return value


def parse_backup_answer(text: str, schema: type[BaseModel]) -> Any:
    """Validates the backup's answer, after fitting it to the schema's length limits."""
    data = json.loads(text)
    spec = schema.model_json_schema()
    return schema.model_validate(_fit(data, spec, spec.get("$defs", {})))


async def _run_backup(instruction: str, prompt: str, schema: type[BaseModel]) -> str:
    """One chat-completion call to the operator's backup provider, in JSON mode. The operator chooses the address (an environment
    variable), so no user input ever becomes an address here. Nothing is logged."""
    base = os.environ["AI_BASE_URL"].strip().rstrip("/")
    body = {
        "model": os.environ["AI_MODEL"].strip(),
        "messages": [
            {"role": "system", "content": f"{instruction}\nAnswer with ONE JSON object that matches this JSON schema, and nothing else: {json.dumps(schema.model_json_schema())}"},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 6000,
        "temperature": 0.3,
    }
    # Provider-specific request settings, chosen by the operator (for example to switch off a slow "thinking" mode): a JSON object in AI_EXTRA_JSON
    try:
        extra = json.loads(os.environ.get("AI_EXTRA_JSON", "") or "{}")
    except ValueError:
        extra = {}
    if isinstance(extra, dict):
        body.update({k: v for k, v in extra.items() if k not in {"model", "messages", "stream"}})
    async with _backup_client() as client:
        resp = await client.post(f"{base}/chat/completions", json=body, headers={"Authorization": f"Bearer {os.environ['AI_API_KEY'].strip()}"})
    if resp.status_code == 429:
        raise RuntimeError("429 quota")
    resp.raise_for_status()
    return str(resp.json()["choices"][0]["message"].get("content") or "")


async def run_structured_with_source(
    *,
    name: str,
    prompt: str,
    schema: type[BaseModel],
    keys: list[str],
    model: str | list[str] | None = None,
    instruction: str = SYSTEM_RULES,
    timeout: float = 30.0,
    deadline: float = 55.0,
    backup_timeout: float = 75.0,
) -> tuple[Any, str]:
    """Asks the model and returns (answer parsed into `schema`, who answered): "gemini" or "backup". Raises LlmUnavailable.

    Gemini is always tried first, with every (model, key) pair. Only when none of them answers is the backup provider
    (if one is configured) asked, and the caller is told, so that what it shows people says who really wrote the text.
    `timeout` bounds one Gemini attempt, `deadline` all the Gemini attempts together."""
    models = [model] if isinstance(model, str) else (model or model_chain())
    started = time.monotonic()
    last: BaseException | None = None
    tried = 0
    if keys:
        for m in models:
            for key in keys:
                slot = (m, _fingerprint(key))
                if _cooldown.get(slot, 0.0) > time.monotonic():
                    continue  # it said "quota" a moment ago
                remaining = deadline - (time.monotonic() - started)
                if remaining < 3:
                    break
                tried += 1
                try:
                    text = await asyncio.wait_for(_run_once(name, instruction, prompt, schema, m, key), min(timeout, remaining))
                except LlmUnavailable:
                    raise
                except Exception as exc:  # quota, network, an unknown model name: try the next pair
                    last = exc
                    if _is_quota(exc):
                        _cooldown[slot] = time.monotonic() + COOLDOWN_SECONDS
                    continue
                try:
                    return schema.model_validate_json(text), "gemini"
                except ValueError as exc:
                    last = exc
    if backup_configured():
        slot = ("backup", _fingerprint(os.environ["AI_API_KEY"]))
        if _cooldown.get(slot, 0.0) <= time.monotonic():
            try:
                text = await asyncio.wait_for(_run_backup(instruction, prompt, schema), backup_timeout)
                return parse_backup_answer(text, schema), "backup"
            except Exception as exc:
                last = exc
                if _is_quota(exc):
                    _cooldown[slot] = time.monotonic() + COOLDOWN_SECONDS
            tried += 1
    if not keys and not backup_configured():
        raise LlmUnavailable("no API key is configured")
    if tried == 0:
        raise LlmUnavailable("every model is out of quota for now (it is tried again in a few minutes)")
    raise LlmUnavailable(f"the model did not answer ({last.__class__.__name__ if last else 'no answer'})")


async def run_structured(**kw: Any) -> Any:
    """Like run_structured_with_source, for callers that only need the answer."""
    return (await run_structured_with_source(**kw))[0]
