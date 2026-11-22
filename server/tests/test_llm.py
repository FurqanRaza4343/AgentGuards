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


# ====================================================================== the optional backup provider

import httpx  # noqa: E402


@pytest.fixture()
def backup_env(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AI_API_KEY", "test-backup-key-1234567890")
    monkeypatch.setenv("AI_BASE_URL", "https://backup.example/v1")
    monkeypatch.setenv("AI_MODEL", "some-model")


def backup_server(monkeypatch: pytest.MonkeyPatch, handler):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(llm, "_backup_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def chat_answer(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_the_backup_needs_a_key_a_model_and_a_plain_http_address(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL"):
        monkeypatch.delenv(name, raising=False)
    assert not llm.backup_configured()
    monkeypatch.setenv("AI_API_KEY", "k" * 20)
    monkeypatch.setenv("AI_MODEL", "m")
    monkeypatch.setenv("AI_BASE_URL", "file:///etc/passwd")
    assert not llm.backup_configured()
    monkeypatch.setenv("AI_BASE_URL", "https://user:pw@backup.example")
    assert not llm.backup_configured()
    monkeypatch.setenv("AI_BASE_URL", "https://backup.example/v1")
    assert llm.backup_configured()


async def test_the_backup_is_asked_only_after_every_gemini_pair_failed_and_the_caller_is_told(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    script(monkeypatch, {})  # every Gemini pair is out of quota
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return chat_answer('{"word": "from the backup"}')

    backup_server(monkeypatch, handler)
    answer, source = await llm.run_structured_with_source(name="t", prompt="the prompt", schema=Answer, keys=["k1"])
    assert answer.word == "from the backup" and source == "backup"
    body = __import__("json").loads(seen[0].content)
    assert seen[0].url.path == "/v1/chat/completions" and seen[0].headers["authorization"] == "Bearer test-backup-key-1234567890"
    assert body["response_format"] == {"type": "json_object"} and body["model"] == "some-model"
    assert "JSON" in body["messages"][0]["content"] and "word" in body["messages"][0]["content"] and body["messages"][1]["content"] == "the prompt"


async def test_the_backup_is_not_touched_while_gemini_answers(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    script(monkeypatch, {("gemini-2.5-flash", "k1"): '{"word": "gemini"}'})

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the backup must not be called when Gemini answers")

    backup_server(monkeypatch, handler)
    answer, source = await llm.run_structured_with_source(name="t", prompt="p", schema=Answer, keys=["k1"])
    assert answer.word == "gemini" and source == "gemini"


async def test_without_any_gemini_key_the_backup_can_still_answer(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    backup_server(monkeypatch, lambda request: chat_answer('{"word": "only backup"}'))
    answer, source = await llm.run_structured_with_source(name="t", prompt="p", schema=Answer, keys=[])
    assert (answer.word, source) == ("only backup", "backup")


async def test_a_backup_that_is_out_of_quota_or_answers_badly_is_an_error_and_a_cooldown(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    script(monkeypatch, {})
    calls: list[int] = []

    def limited(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(429, json={"error": "slow down"})

    backup_server(monkeypatch, limited)
    with pytest.raises(llm.LlmUnavailable):
        await ask()
    assert len(calls) == 1
    with pytest.raises(llm.LlmUnavailable, match="out of quota for now"):
        await ask()
    assert len(calls) == 1  # cooling down: not asked again

    llm._cooldown.clear()
    backup_server(monkeypatch, lambda request: chat_answer("this is not json"))
    with pytest.raises(llm.LlmUnavailable):
        await ask()
    backup_server(monkeypatch, lambda request: httpx.Response(500))
    with pytest.raises(llm.LlmUnavailable):
        await ask()


async def test_run_structured_still_returns_just_the_answer(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    script(monkeypatch, {("gemini-2.5-flash", "k1"): '{"word": "plain"}'})
    assert (await llm.run_structured(name="t", prompt="p", schema=Answer, keys=["k1"])).word == "plain"


def test_an_answer_that_is_too_long_is_cut_to_the_schemas_limits_not_thrown_away() -> None:
    from pydantic import Field

    class Item(BaseModel):
        text: str = Field(max_length=10)
        note: str | None = Field(default=None, max_length=5)

    class Batch(BaseModel):
        items: list[Item] = Field(max_length=2)
        title: str = Field(max_length=8)

    answer = llm.parse_backup_answer('{"items": [{"text": "0123456789ABC", "note": "toolongnote"}, {"text": "ok"}, {"text": "third"}], "title": "a very long title"}', Batch)
    assert [i.text for i in answer.items] == ["0123456789", "ok"] and answer.items[0].note == "toolo" and answer.title == "a very l"
    with pytest.raises(Exception):
        llm.parse_backup_answer('{"items": [{"nope": 1}], "title": "x"}', Batch)  # a missing field is still an error


async def test_extra_request_settings_from_the_environment_reach_the_backup_but_cannot_replace_the_prompt(monkeypatch: pytest.MonkeyPatch, backup_env) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AI_EXTRA_JSON", '{"thinking": {"type": "disabled"}, "messages": [], "model": "evil", "stream": true}')
    script(monkeypatch, {})
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(__import__("json").loads(request.content))
        return chat_answer('{"word": "x"}')

    backup_server(monkeypatch, handler)
    await ask(keys=[])
    body = seen[0]
    assert body["thinking"] == {"type": "disabled"} and body["model"] == "some-model" and body["messages"] and "stream" not in body
