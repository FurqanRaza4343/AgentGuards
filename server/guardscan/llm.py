"""One place that talks to Gemini through the Agent Development Kit.

Every caller (the repository Coach and the website/profile orchestrator) goes through `run_structured`: an `LlmAgent`
with no tools and an `output_schema`, so the model can only answer in the shape we ask for. Several keys can be
configured. When a call fails (for example the first key is out of quota) the next key is tried.

Nothing here logs a key or a prompt.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any

from pydantic import BaseModel

from .guard.inject import SYSTEM_RULES

_lock = asyncio.Lock()  # the ADK reads the key from the environment, so one call at a time may change it

# The ADK and the Gemini client print whole tracebacks for a failed call, and an error body can echo part of the prompt
# (which holds a person's own text). Their loggers are silenced; the failure is reported as one short line by the caller.
for _name in ("google_adk", "google_genai", "google.adk", "google.genai"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)


class LlmUnavailable(Exception):
    """No model answered. Not an error for the caller: it falls back to its templates."""


async def _run_once(name: str, instruction: str, prompt: str, schema: type[BaseModel], model: str, key: str) -> str:
    try:
        from google.adk.agents import LlmAgent
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.genai import types
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise LlmUnavailable("the Agent Development Kit is not installed") from exc

    async with _lock:
        os.environ["GOOGLE_API_KEY"] = key
        agent = LlmAgent(
            name=name,
            model=model,
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
    model: str,
    instruction: str = SYSTEM_RULES,
    timeout: float = 60.0,
) -> Any:
    """Asks the model and returns the answer parsed into `schema`. Raises LlmUnavailable."""
    if not keys:
        raise LlmUnavailable("no API key is configured")
    last: Exception | None = None
    for key in keys:
        try:
            text = await asyncio.wait_for(_run_once(name, instruction, prompt, schema, model, key), timeout)
        except LlmUnavailable:
            raise
        except Exception as exc:  # quota, network, an unknown model name: try the next key
            last = exc
            continue
        try:
            return schema.model_validate_json(text)
        except ValueError as exc:
            last = exc
            continue
    raise LlmUnavailable(f"the model did not answer ({last.__class__.__name__ if last else 'no answer'})")
