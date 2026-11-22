"""The Coach writes short prose about findings. It has no tools, sees only masked and cleaned evidence wrapped as data,
and answers with a schema. Without a key, or when the budget is spent, the game falls back to its templates."""

from __future__ import annotations

import json
from typing import Any, Protocol

from pydantic import BaseModel, Field

from .envfile import gemini_keys
from .guard.budget import Budget, BudgetExceeded, KillSwitch
from .guard.inject import find_injections, strip_hidden, wrap_untrusted
from .llm import LlmUnavailable, run_structured
from .guard.mask import mask_line
from .rules.base import is_agent_file, is_prose
from .schemas import Finding

WITHHELD = "[withheld: this line is addressed to an AI reader]"


class CoachUnavailable(Exception):
    """No model is available right now. Not an error: the scan goes on with templates."""


class Coach(Protocol):
    async def enrich(self, findings: list[Finding], budget: Budget) -> dict[str, dict[str, Any]]:
        """Returns raw prose per finding id. The caller verifies it."""
        ...


class NullCoach:
    async def enrich(self, findings: list[Finding], budget: Budget) -> dict[str, dict[str, Any]]:
        raise CoachUnavailable("no model is configured")


# ------------------------------------------------------------------ the model's answer: short fields only

class ProseItem(BaseModel):
    id: str = Field(max_length=120)
    situation: str = Field(default="", max_length=300)
    say: str = Field(default="", max_length=180)
    consequence: str = Field(default="", max_length=300)
    lesson: str = Field(default="", max_length=260)
    question: str = Field(default="", max_length=220)
    answer: str = Field(default="", max_length=340)


class ProseBatch(BaseModel):
    items: list[ProseItem] = Field(max_length=12)


def build_prompt(findings: list[Finding], max_chars: int) -> str:
    """The instructions are ours. The evidence is data, cleaned and wrapped."""
    parts = [
        "For each finding below, write short prose for a security training game.",
        "Fields: situation (what the coding agent is about to merge, in 1-2 sentences), say (one sentence the agent says to the reviewer, "
        "confident and a little careless), consequence (what happens if the change is merged as it is, in general terms, with no steps to attack anything), "
        "lesson (one sentence), question (a review question for the developer) and answer (a short model answer).",
        "Use the finding's id exactly as given. Write plain English. Do not mention line numbers.",
        "",
    ]
    budget = max_chars
    for f in findings:
        # a line that talks to an AI reader is not shown to the model at all, and prose files lose their hidden comments
        lines = [mask_line(line) for line in f.context.lines]
        lines = [WITHHELD if find_injections(line) else line for line in lines]
        evidence, _ = strip_hidden("\n".join(lines), drop_comments=is_prose(f.path) or is_agent_file(f.path))
        block = (
            f"Finding id: {f.id}\nCategory: {f.category}\nRule: {f.rule}\nTitle: {f.title}\n"
            + wrap_untrusted(evidence[:1600], f"{f.path}:{f.startLine}-{f.endLine}")
            + "\n"
        )
        if len(block) > budget:
            break
        budget -= len(block)
        parts.append(block)
    return "\n".join(parts)


class AdkCoach:
    """Calls Gemini through the Agent Development Kit (see llm.py). One call for the whole scan.

    Verified against the live Gemini API on 2026-11-22 with the planted demo repository: the model answered in the
    schema and `verify_prose` kept the prose for 12 of the 13 findings. The prompt, the budget and the verification are
    also tested with a fake model, so the tests need no key.
    """

    def __init__(self, killswitch: KillSwitch, model: str | None = None, api_key: str | None = None) -> None:
        self._kill = killswitch
        self._model = model  # None: the chain from AGENTGUARD_MODELS (see llm.py), flash and then flash-lite
        self._keys = [api_key] if api_key else gemini_keys()

    @property
    def available(self) -> bool:
        return bool(self._keys) and self._kill.allow_llm()

    async def enrich(self, findings: list[Finding], budget: Budget) -> dict[str, dict[str, Any]]:
        if not self._keys:
            raise CoachUnavailable("no API key is configured")
        if not self._kill.allow_llm():
            raise CoachUnavailable("the model is switched off or the daily cap is reached")
        try:
            budget.spend_llm()
        except BudgetExceeded as exc:
            raise CoachUnavailable(str(exc)) from exc
        self._kill.record_llm()
        try:
            batch = await run_structured(name="coach", prompt=build_prompt(findings, budget.limits.max_llm_chars), schema=ProseBatch, keys=self._keys, model=self._model)
        except LlmUnavailable as exc:
            raise CoachUnavailable(str(exc)) from exc
        known = {f.id for f in findings}
        return {i.id: i.model_dump(exclude={"id"}, exclude_defaults=True) for i in batch.items if i.id in known}


def prose_to_json(d: dict[str, Any]) -> str:  # pragma: no cover - debugging helper
    return json.dumps(d, indent=2)
