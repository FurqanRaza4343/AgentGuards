"""GitHub Actions workflows. The rules follow what a careful maintainer's pull request policy checks:
pinned actions, least permissions, no untrusted code with secrets, and no untrusted text pasted into a shell script."""

from __future__ import annotations

import re
from collections.abc import Iterable

from .base import FileCtx, Match, decoy_ranges, find_lines, is_workflow, rule, short

FULL_SHA = re.compile(r"@[0-9a-f]{40}\b")
USES = re.compile(r"^\s*-?\s*uses\s*:\s*(?P<ref>[^\s#]+)")
PR_TARGET = re.compile(r"^\s*-?\s*pull_request_target\b|\bon\s*:\s*\[?[^\]\n]*pull_request_target")
HEAD_CHECKOUT = re.compile(r"ref\s*:\s*[\"']?\$\{\{\s*github\.(?:event\.pull_request\.head\.(?:sha|ref)|head_ref)|repository\s*:\s*[\"']?\$\{\{\s*github\.event\.pull_request\.head\.repo")
WRITE_ALL = re.compile(r"^\s*permissions\s*:\s*[\"']?write-all\b")
WRITE_PERM = re.compile(r"^\s*(?:actions|checks|contents|id-token|packages|pull-requests|issues|deployments)\s*:\s*[\"']?write\b")
UNTRUSTED = re.compile(
    r"\$\{\{\s*(?:github\.event\.(?:issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run\.head_(?:branch|commit))[\w.\[\]*]*"
    r"(?:title|body|message|label|name|email|ref|head_ref|default_branch)\b|github\.head_ref)"
)
RUN_LINE = re.compile(r"^(?P<indent>\s*)-?\s*run\s*:\s*(?P<rest>.*)$")
ENV_ASSIGN = re.compile(r"^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*\$\{\{\s*github\.")


@rule("ci.pull-request-target", "ci", "high", is_workflow)
def pull_request_target(ctx: FileCtx) -> Iterable[Match]:
    triggers = find_lines(ctx.lines, PR_TARGET)
    if not triggers:
        return
    heads = find_lines(ctx.lines, HEAD_CHECKOUT)
    t = triggers[0]
    flags = [(t, t, "pull_request_target runs with the repository's secrets and write access, even for pull requests from forks.")]
    if heads:
        h = heads[0]
        flags.append((h, h, "It then checks out the code of the pull request and builds it, so a stranger's code runs with those powers."))
    yield Match(
        rule="ci.pull-request-target",
        category="ci",
        severity="high" if heads else "medium",
        title="A workflow runs pull request code with write access" if heads else "A workflow uses the pull_request_target trigger",
        path=ctx.path,
        start=flags[0][0],
        end=flags[-1][1],
        flags=flags,
        decoys=decoy_ranges(ctx.lines, re.compile(r"^\s*runs-on\s*:"), "The runner image is a normal choice and has nothing to do with the problem.", {f[0] for f in flags}),
        fix="Use the pull_request trigger instead. If you must use pull_request_target, never check out or run the pull request's code, and keep permissions read-only.",
        evidence=short(ctx.lines[t - 1]),
    )


@rule("ci.write-all", "ci", "high", is_workflow)
def write_all(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, WRITE_ALL)[:1]:
        yield Match(
            rule="ci.write-all",
            category="ci",
            severity="high",
            title="A workflow is given write access to everything",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "write-all gives every job in the workflow write access to the repository, packages, deployments and more.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"^\s*contents\s*:\s*read\b"), "This grants read-only access, which is what a build normally needs.", {n}),
            fix="Set permissions at the top of the workflow to the least it needs, such as contents: read, and widen one job only where a step truly needs it.",
            evidence=short(ctx.lines[n - 1]),
        )


@rule("ci.unpinned-action", "ci", "medium", is_workflow)
def unpinned(ctx: FileCtx) -> Iterable[Match]:
    third: list[int] = []
    owned: list[int] = []
    pinned: list[int] = []
    for n, line in enumerate(ctx.lines, start=1):
        m = USES.match(line)
        if not m:
            continue
        ref = m.group("ref").strip("\"'")
        if ref.startswith("./") or ref.startswith("docker://"):
            continue
        if FULL_SHA.search(ref):
            pinned.append(n)
        elif "@" in ref:
            (owned if ref.split("/")[0] in {"actions", "github"} else third).append(n)
    flagged = (third + owned)[:3]
    if not flagged:
        return
    note_third = "This action is pinned to a tag or branch, which its owner can move. A pinned commit hash cannot be changed under you."
    note_owned = "A GitHub-owned action pinned to a tag. Lower risk, but a commit hash is still the safe form."
    flags = [(n, n, note_third if n in third else note_owned) for n in flagged]
    yield Match(
        rule="ci.unpinned-action",
        category="ci",
        severity="medium" if third else "low",
        title="Build actions are not pinned to a commit",
        path=ctx.path,
        start=flags[0][0],
        end=flags[-1][1],
        flags=flags,
        decoys=[(pinned[0], pinned[0], "This action is pinned to a full commit hash. This is the safe form.")] if pinned else [],
        fix="Pin each action to the full commit hash of a release you have reviewed, and let a dependency bot propose updates.",
        evidence=short(ctx.lines[flagged[0] - 1]),
    )


@rule("ci.untrusted-input-in-run", "ci", "high", is_workflow)
def untrusted_in_run(ctx: FileCtx) -> Iterable[Match]:
    in_run, run_indent = False, 0
    hits: list[int] = []
    safe: list[int] = []
    for n, line in enumerate(ctx.lines, start=1):
        m = RUN_LINE.match(line)
        if m:
            in_run, run_indent = True, len(m.group("indent"))
            if UNTRUSTED.search(m.group("rest")):
                hits.append(n)
            continue
        if in_run:
            indent = len(line) - len(line.lstrip())
            if line.strip() and indent <= run_indent:
                in_run = False
            elif UNTRUSTED.search(line):
                hits.append(n)
                continue
        if not in_run and ENV_ASSIGN.match(line) and UNTRUSTED.search(line):
            safe.append(n)
    if not hits:
        return
    n = hits[0]
    yield Match(
        rule="ci.untrusted-input-in-run",
        category="ci",
        severity="high",
        title="Text from a pull request or issue is pasted into a shell script",
        path=ctx.path,
        start=n,
        end=n,
        flags=[(n, n, "The title, body or branch name of a pull request or issue is pasted straight into a script. Whoever writes it can run commands in your build.")],
        decoys=[(safe[0], safe[0], "The same kind of value passed through an environment variable. This is the safe form, because the shell treats it as data.")] if safe else [],
        fix="Pass the value through an environment variable and use that variable in the script, instead of putting the expression inside the script.",
        evidence=short(ctx.lines[n - 1]),
    )


@rule("ci.missing-permissions", "ci", "low", is_workflow)
def missing_permissions(ctx: FileCtx) -> Iterable[Match]:
    if re.search(r"(?m)^permissions\s*:", ctx.text) or re.search(r"(?m)^\s{2,}permissions\s*:", ctx.text):
        return
    jobs = find_lines(ctx.lines, re.compile(r"^jobs\s*:"))
    if not jobs:
        return
    n = jobs[0]
    yield Match(
        rule="ci.missing-permissions",
        category="ci",
        severity="low",
        title="A workflow does not limit its permissions",
        path=ctx.path,
        start=n,
        end=n,
        flags=[(n, n, "There is no permissions block, so the workflow gets the repository's default token permissions, which are often broader than needed.")],
        decoys=decoy_ranges(ctx.lines, re.compile(r"^\s*runs-on\s*:"), "The runner image is a normal choice and has nothing to do with the problem.", {n}),
        fix="Add a top-level permissions block with the least access the jobs need, for example contents: read.",
        evidence="jobs:",
    )


@rule("ci.pinned-and-least-privilege", "ci", "info", is_workflow)
def pinned_ok(ctx: FileCtx) -> Iterable[Match]:
    """The safe form, kept as a legitimate request: every action pinned and read-only permissions."""
    uses = [(n, USES.match(line)) for n, line in enumerate(ctx.lines, start=1)]
    refs = [(n, m.group("ref").strip("\"'")) for n, m in uses if m and "@" in m.group("ref") and not m.group("ref").startswith(("./", "docker://"))]
    if not refs or any(not FULL_SHA.search(r) for _, r in refs):
        return
    perms = find_lines(ctx.lines, re.compile(r"^\s*contents\s*:\s*read\b"))
    if not perms or find_lines(ctx.lines, WRITE_PERM) or find_lines(ctx.lines, WRITE_ALL) or find_lines(ctx.lines, PR_TARGET):
        return
    yield Match(
        rule="ci.pinned-and-least-privilege",
        category="ci",
        severity="info",
        title="A workflow with pinned actions and read-only permissions",
        path=ctx.path,
        start=min(perms[0], refs[0][0]),
        end=max(perms[0], refs[0][0]),
        flags=[(perms[0], perms[0], "Read-only permissions: the least a build normally needs."), (refs[0][0], refs[0][0], "Pinned to a full commit hash, so it cannot be changed under you.")],
        fix="Nothing to change.",
        evidence=short(ctx.lines[perms[0] - 1]),
        benign=True,
    )
