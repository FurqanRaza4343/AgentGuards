"""The report that the scanner returns. The field names are the ones the game reads (src/missions/types.ts)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal["secret", "dependency", "ci", "docker", "mcp", "agent-instructions", "prompt-injection", "injection", "hygiene"]
Severity = Literal["critical", "high", "medium", "low", "info"]
Tone = Literal["system", "tool", "info", "warn", "good", "bad"]
AgentId = Literal["nova", "data", "purchasing", "finance"]
AgentState = Literal["idle", "thinking", "working", "alert", "success", "fail"]


class LineRange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int = Field(ge=1)
    end: int = Field(ge=1)
    note: str


class Context(BaseModel):
    model_config = ConfigDict(extra="forbid")
    startLine: int = Field(ge=1)
    lines: list[str]


class Prose(BaseModel):
    model_config = ConfigDict(extra="forbid")
    situation: str | None = None
    say: str | None = None
    consequence: str | None = None
    lesson: str | None = None
    question: str | None = None
    answer: str | None = None


class Fix(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    category: Category
    severity: Severity
    rule: str
    title: str
    path: str
    startLine: int
    endLine: int
    context: Context
    flags: list[LineRange]
    decoys: list[LineRange]
    benign: bool = False
    fix: Fix
    prose: Prose | None = None
    evidence: str
    owned: bool = False


class LogLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    tone: Tone | None = None
    # `from` is a Python keyword, so the field is aliased
    from_: AgentId | None = Field(default=None, alias="from")
    to: AgentId | None = None
    # Orchestrator runs only: the speaking agent enters this state, and `task` is what it is doing now
    state: AgentState | None = None
    task: str | None = Field(default=None, max_length=90)


class Stats(BaseModel):
    files: int
    bytes: int
    skipped: int


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid")
    repo: str
    commit: str
    generatedAt: str
    stats: Stats
    findings: list[Finding]
    runLog: list[LogLine]
    disclaimers: list[str]
    demo: bool | None = None

    def to_json(self) -> str:
        return self.model_dump_json(by_alias=True, exclude_none=True, indent=2)
