"""The model fallback: (model, key) pairs in order, a pair that is out of quota is skipped for a while, and a run has a deadline."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from guardscan import llm


class Answer(BaseModel):
    word: str


class Quota(Exception):
    """Looks like the error the Gemini client raises when the free quota is used up."""


@pytest.fixture(autouse=True)
def fresh_cooldowns(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(llm, "_cooldown", {})
    for name in ("AGENTGUARD_MODELS", "AGENTGUARD_MODEL"):
        monkeypatch.delenv(name, raising=False)


def script(monkeypatch: pytest.MonkeyPatch, plan: dict[tuple[str, str], object]) -> list[tuple[str, str]]:
    """Replaces the real call. `plan` maps (model, key) to either an exception or the text to answer with."""
    calls: list[tuple[str, str]] = []

    async def fake(name, instruction, prompt, schema, model, key):  # type: ignore[no-untyped-def]
        calls.append((model, key))
        outcome = plan.get((model, key), Quota("429 RESOURCE_EXHAUSTED"))
        if isinstance(outcome, BaseException):
            raise outcome
        return str(outcome)

    monkeypatch.setattr(llm, "_run_once", fake)
    return calls


async def ask(**kw):  # type: ignore[no-untyped-def]
    return await llm.run_structured(name="t", prompt="p", schema=Answer, keys=kw.pop("keys", ["k1", "k2"]), **kw)


def test_the_default_chain_is_flash_then_flash_lite_and_the_environment_can_change_it(monkeypatch: pytest.MonkeyPatch) -> None:
    assert llm.model_chain() == ["gemini-2.5-flash", "gemini-2.5-flash-lite"]
    monkeypatch.setenv("AGENTGUARD_MODELS", "a, b ,c")
    assert llm.model_chain() == ["a", "b", "c"]
    monkeypatch.setenv("AGENTGUARD_MODEL", "z")
    assert llm.model_chain() == ["z", "a", "b", "c"]
    monkeypatch.setenv("AGENTGUARD_MODEL", "b")
    assert llm.model_chain() == ["a", "b", "c"]


async def test_the_first_pair_that_works_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = script(monkeypatch, {("gemini-2.5-flash", "k1"): '{"word": "ok"}'})
    assert (await ask()).word == "ok" and calls == [("gemini-2.5-flash", "k1")]


async def test_when_flash_is_out_of_quota_for_every_key_flash_lite_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = script(monkeypatch, {("gemini-2.5-flash-lite", "k1"): '{"word": "lite"}'})
    assert (await ask()).word == "lite"
    assert calls == [("gemini-2.5-flash", "k1"), ("gemini-2.5-flash", "k2"), ("gemini-2.5-flash-lite", "k1")]


async def test_a_pair_out_of_quota_is_not_tried_again_for_a_while(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = script(monkeypatch, {("gemini-2.5-flash-lite", "k1"): '{"word": "lite"}'})
    await ask()
    calls.clear()
    assert (await ask()).word == "lite"
    assert calls == [("gemini-2.5-flash-lite", "k1")]  # the three failed pairs were skipped: no time wasted on them


async def test_the_cooldown_ends(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = script(monkeypatch, {("gemini-2.5-flash-lite", "k1"): '{"word": "lite"}'})
    await ask()
    for slot in list(llm._cooldown):
        llm._cooldown[slot] = 0.0
    calls.clear()
    await ask()
    assert calls[0] == ("gemini-2.5-flash", "k1")


async def test_an_error_that_is_not_about_quota_does_not_start_a_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    script(monkeypatch, {("gemini-2.5-flash", "k1"): RuntimeError("the network blinked"), ("gemini-2.5-flash", "k2"): '{"word": "ok"}'})
    assert (await ask()).word == "ok"
    assert llm._cooldown == {}


async def test_an_answer_that_is_not_in_the_schema_moves_on_to_the_next_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = script(monkeypatch, {("gemini-2.5-flash", "k1"): "not json", ("gemini-2.5-flash", "k2"): '{"word": "second"}'})
    assert (await ask()).word == "second" and len(calls) == 2


async def test_when_nothing_works_the_caller_gets_one_clear_exception_and_then_a_fast_one(monkeypatch: pytest.MonkeyPatch) -> None:
    script(monkeypatch, {})
    with pytest.raises(llm.LlmUnavailable, match="did not answer"):
        await ask()
    calls = script(monkeypatch, {})
    with pytest.raises(llm.LlmUnavailable, match="out of quota for now"):
        await ask()
    assert calls == []  # every pair is cooling down: no call was made at all


async def test_no_key_is_an_error_and_an_explicit_model_is_used_as_given(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(llm.LlmUnavailable, match="no API key"):
        await ask(keys=[])
    calls = script(monkeypatch, {("my-model", "k1"): '{"word": "x"}'})
    await ask(model="my-model")
    assert calls == [("my-model", "k1")]


async def test_the_deadline_stops_a_slow_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    async def slow(name, instruction, prompt, schema, model, key):  # type: ignore[no-untyped-def]
        await asyncio.sleep(5)
        return '{"word": "late"}'

    monkeypatch.setattr(llm, "_run_once", slow)
    with pytest.raises(llm.LlmUnavailable):
        await ask(timeout=0.2, deadline=3.5)


def test_a_key_is_never_stored_only_a_fingerprint_of_it() -> None:
    fp = llm._fingerprint("AIza-super-secret-value")
    assert "secret" not in fp and len(fp) == 12 and fp == llm._fingerprint("AIza-super-secret-value")
