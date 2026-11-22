"""One place that talks to Gemini through the Agent Development Kit.

Every caller (the repository Coach and the website/profile orchestrator) goes through `run_structured`: an `LlmAgent`
with no tools and an `output_schema`, so the model can only answer in the shape we ask for.

Fallback, because the free tier has small quotas that are counted per model AND per key: the attempts are (model, key)
pairs, in order. With the default chain, `gemini-2.5-flash` is tried with every key, then `gemini-2.5-flash-lite` (a separate
quota) with every key. A pair that answered "quota" is skipped for a few minutes, so a run does not pay for the same
failure again. The whole thing has a deadline, so a run never waits long for a model that is not going to answer.

Nothing here logs a key or a prompt.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from typing import Any

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


async def run_structured(
    *,
    name: str,
    prompt: str,
    schema: type[BaseModel],
    keys: list[str],
    model: str | list[str] | None = None,
    instruction: str = SYSTEM_RULES,
    timeout: float = 30.0,
    deadline: float = 55.0,
) -> Any:
    """Asks the model and returns the answer parsed into `schema`. Raises LlmUnavailable.

    `timeout` bounds one attempt, `deadline` bounds all of them together."""
    if not keys:
        raise LlmUnavailable("no API key is configured")
    models = [model] if isinstance(model, str) else (model or model_chain())
    started = time.monotonic()
    last: BaseException | None = None
    tried = 0
    for m in models:
        for key in keys:
            slot = (m, _fingerprint(key))
            if _cooldown.get(slot, 0.0) > time.monotonic():
                continue  # it said "quota" a moment ago
            remaining = deadline - (time.monotonic() - started)
            if remaining < 3:
                raise LlmUnavailable("the model did not answer in time")
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
                return schema.model_validate_json(text)
            except ValueError as exc:
                last = exc
    if tried == 0:
        raise LlmUnavailable("every model is out of quota for now (it is tried again in a few minutes)")
    raise LlmUnavailable(f"the model did not answer ({last.__class__.__name__ if last else 'no answer'})")
