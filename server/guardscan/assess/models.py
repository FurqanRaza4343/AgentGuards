"""The report for a website or a profile. The field names are the ones the browser reads (src/assess/types.ts)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..schemas import AgentId, LogLine, Severity

Kind = Literal["site", "profile"]
Area = Literal["security", "privacy", "content", "seo", "accessibility", "discoverability"]


class AFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    area: Area
    severity: Severity
    rule: str
    title: str
    detail: str
    evidence: str = ""  # a short, masked excerpt; never a secret
    location: str = ""  # a page address or a section name
    fix: str
    by: AgentId  # which specialist found it


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    text: str
    why: str
    area: Area
    findingId: str | None = None


class Improvement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    title: str
    before: str = ""
    after: str
    findingId: str | None = None


class AgentSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: AgentId
    role: str
    task: str
    summary: str
    findingIds: list[str] = Field(default_factory=list)


class SearchInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    used: bool
    note: str
    queries: list[str] = Field(default_factory=list)


class AssessStats(BaseModel):
    pages: int = 0
    bytes: int = 0
    words: int = 0


class AssessReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    target: str
    generatedAt: str
    stats: AssessStats
    agents: list[AgentSummary]
    findings: list[AFinding]
    strengths: list[str] = Field(default_factory=list)
    questions: list[Question]
    improvements: list[Improvement]
    search: SearchInfo
    model: bool  # True when a language model wrote the questions and improvements (False: templates)
    backup: bool = False  # True when that model was the backup provider, not Gemini: the interface must say so
    runLog: list[LogLine]
    disclaimers: list[str]
    demo: bool | None = None
