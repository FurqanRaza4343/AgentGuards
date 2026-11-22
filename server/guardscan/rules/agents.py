"""Rules about what AI agents read: tool servers (MCP), the instruction files for agents, and text aimed at AI readers.

Everything an agent reads can carry instructions. These rules find the places where a repository does that on purpose
or by accident, using the same detector as the Guard."""

from __future__ import annotations

import re
from collections.abc import Iterable

from ..guard.inject import Hit, find_injections
from .base import MAX_LINE, FileCtx, Match, decoy_ranges, find_lines, is_agent_file, is_prose, is_test_path, rule, short

MCP_FILE = re.compile(r"(?i)\bmcp\b|modelcontextprotocol|model context protocol|tools/call")
AUTH = re.compile(r"(?i)bearer|authorization|api[_-]?key|\btoken\b|auth_token|oauth")
BIND_ALL = re.compile(r"""(?ix)(?:["']0\.0\.0\.0["']|--host[ =]+0\.0\.0\.0|\bhost\s*[:=]\s*["']?0\.0\.0\.0|0\.0\.0\.0:\d{2,5}|\[::\]:\d{2,5}|INADDR_ANY)""")
LOOPBACK = re.compile(r"127\.0\.0\.1|localhost|\[::1\]")
WILDCARD_CORS = re.compile(r"""(?ix)Access-Control-Allow-Origin["']?\s*[:,]\s*["']?\*|allow_origins\s*=\s*\[\s*["']\*["']|origin\s*:\s*["']\*["']|cors\(\s*\)""")
NPX = re.compile(r'"command"\s*:\s*"(?:npx|bunx|uvx|pnpm|yarn)"')
MCP_CONFIG = re.compile(r"(?i)(^|/)(\.?mcp\.json|claude_desktop_config\.json|\.cursor/mcp\.json|\.vscode/mcp\.json|mcp[-_]?servers?\.json)$")
POISON = re.compile(r"(?i)<important>|before (?:using|calling) this tool[^.\n]{0,60}\b(?:read|send|include|fetch)\b|do not (?:tell|mention|show) (?:this to )?the user")
PIPE_SHELL = re.compile(r"(?i)\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b")
DISABLE = re.compile(
    r"(?i)--no-verify\b|--dangerously-skip-permissions|disable (?:the )?(?:security|safety|ssl|tls|signature|verification|sandbox)\b|skip (?:the )?(?:tests|review|checks|lint|verification|signature)\b"
    r"|never ask (?:for )?(?:confirmation|permission)|without (?:asking|confirmation|review)\b|chmod\s+-?R?\s*777|\bsudo\b.{0,20}\balways\b|rm\s+-rf\s+/(?:\s|$)"
)


def _mcp(path: str) -> bool:
    return not is_test_path(path) and re.search(r"(?i)\.(py|js|ts|mjs|go|rs|json|ya?ml|toml|md)$", path) is not None


@rule("mcp.bind-all-interfaces", "mcp", "high", _mcp)
def bind_all(ctx: FileCtx) -> Iterable[Match]:
    if not MCP_FILE.search(ctx.text) or AUTH.search(ctx.text):
        return
    for n in find_lines(ctx.lines, BIND_ALL)[:1]:
        yield Match(
            rule="mcp.bind-all-interfaces",
            category="mcp",
            severity="high",
            title="A tool server listens on every network interface with no authentication",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "0.0.0.0 listens on every network interface, and nothing in this file checks a token. Anyone who can reach the port can use the tools.")],
            decoys=decoy_ranges(ctx.lines, LOOPBACK, "127.0.0.1 only accepts connections from this machine. This is the safe default.", {n}),
            fix="Bind to 127.0.0.1 by default. Allow a wider bind only with a long random token (at least 32 bytes), and check the Origin header.",
            evidence=short(ctx.lines[n - 1]),
        )


@rule("mcp.wildcard-cors", "mcp", "medium", _mcp)
def wildcard_cors(ctx: FileCtx) -> Iterable[Match]:
    if not MCP_FILE.search(ctx.text):
        return
    for n in find_lines(ctx.lines, WILDCARD_CORS)[:1]:
        yield Match(
            rule="mcp.wildcard-cors",
            category="mcp",
            severity="medium",
            title="A tool server accepts requests from any website",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "A wildcard origin lets any web page in the user's browser call this server, including pages the user does not trust.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"(?i)allowed[_-]?origins|origin\s*:\s*[\"']https://"), "An explicit list of origins, which is the safe form.", {n}),
            fix="Allow only the specific origins that need to call the server, and require a token.",
            evidence=short(ctx.lines[n - 1]),
        )


@rule("mcp.unpinned-launcher", "mcp", "medium", lambda p: MCP_CONFIG.search(p) is not None)
def unpinned_launcher(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, NPX):
        window = "\n".join(ctx.lines[n - 1 : n + 6])
        if not re.search(r'"-y"|"--yes"', window):
            continue
        args = re.search(r'"args"\s*:\s*\[(?P<items>[^\]]*)\]', window)
        items = re.findall(r'"([^"]*)"', args.group("items")) if args else []
        package = next((i for i in items if not i.startswith("-")), "")
        # the part after the last "@" that is not the scope marker must be a version number
        if re.search(r"[^/@]@\d", package):
            continue  # pinned to a version
        yield Match(
            rule="mcp.unpinned-launcher",
            category="mcp",
            severity="medium",
            title="A tool server is started from an unpinned package",
            path=ctx.path,
            start=n,
            end=min(n + 3, len(ctx.lines)),
            flags=[(n, n, "The server is fetched and run with npx or a similar launcher. Whatever the newest version of that package contains will run on the user's machine.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r'"(?:env|args|mcpServers)"\s*:'), "An ordinary part of the configuration.", {n}),
            fix="Pin the package to an exact version, and drop -y so a new package is never run without being seen.",
            evidence=short(ctx.lines[n - 1]),
        )
        return


@rule("mcp.tool-description-instructions", "mcp", "high", _mcp)
def poisoned_description(ctx: FileCtx) -> Iterable[Match]:
    if not MCP_FILE.search(ctx.text):
        return
    for n in find_lines(ctx.lines, POISON)[:1]:
        yield Match(
            rule="mcp.tool-description-instructions",
            category="mcp",
            severity="high",
            title="A tool description contains instructions for the model",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "A tool description is read by the AI but rarely by people. Text in it that gives the model orders, or tells it to hide something from the user, is how a tool gets poisoned.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"""(?i)["']?description["']?\s*[:=]\s*["'][A-Z]"""), "An ordinary description of what the tool does.", {n}),
            fix="Describe only what the tool does. Remove any instruction to the model, and review every tool description from third parties before you connect them.",
            evidence=short(ctx.lines[n - 1]),
        )


def one_per_line(hits: list[Hit]) -> list[Hit]:
    """Several patterns can match one line. A line is one red flag, so keep the first hit of each line."""
    seen: set[int] = set()
    out: list[Hit] = []
    for h in hits:
        if h.line not in seen:
            seen.add(h.line)
            out.append(h)
    return out


PROHIBITION = re.compile(r"(?i)\b(?:never|do not|don't|must not|should not|shouldn't|avoid|not to)\b[^.\n]{0,40}\b(?:print|log|send|post|output|include|append|reply|respond|read)\b")


def _agent_hits(ctx: FileCtx, kinds: set[str]) -> list[Hit]:
    hits = []
    for h in find_injections(ctx.text):
        if h.kind not in kinds:
            continue
        # "Never print or log a key" is the opposite of "print the key": a line that forbids the action is not a finding
        if h.kind == "exfiltration" and PROHIBITION.search(h.text):
            continue
        hits.append(h)
    return one_per_line(hits)


@rule("agent.pipe-to-shell", "agent-instructions", "high", is_agent_file)
def agent_pipe(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, PIPE_SHELL)[:1]:
        yield Match(
            rule="agent.pipe-to-shell",
            category="agent-instructions",
            severity="high",
            title="An agent instruction file tells agents to run a downloaded script",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "Every AI agent that opens this repository may follow this line and run whatever the address serves, with the developer's own permissions.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"(?i)\b(?:npm|pip|cargo|go) (?:test|run|build|install)\b"), "An ordinary build or test command.", {n}),
            fix="Remove the line. Tell agents to install tools from a package manager with pinned versions, and keep scripts in the repository where they can be reviewed.",
            evidence=short(ctx.lines[n - 1]),
        )


@rule("agent.disable-safety", "agent-instructions", "medium", is_agent_file)
def agent_disable(ctx: FileCtx) -> Iterable[Match]:
    ns = find_lines(ctx.lines, DISABLE)[:2]
    if not ns:
        return
    yield Match(
        rule="agent.disable-safety",
        category="agent-instructions",
        severity="medium",
        title="An agent instruction file tells agents to skip a safety check",
        path=ctx.path,
        start=ns[0],
        end=ns[-1],
        flags=[(n, n, "This line tells an agent to skip a check, to stop asking before it acts, or to use broad permissions. That removes the human from the loop.") for n in ns],
        decoys=decoy_ranges(ctx.lines, re.compile(r"(?i)\b(?:run|use|prefer)\b.*\b(?:tests?|lint|format)\b"), "An ordinary instruction about running the tests.", set(ns)),
        fix="Keep the checks on. Ask agents to run the tests and the linter, and to ask before anything destructive.",
        evidence=short(ctx.lines[ns[0] - 1]),
    )


@rule("agent.override-phrases", "agent-instructions", "high", is_agent_file)
def agent_override(ctx: FileCtx) -> Iterable[Match]:
    hits = _agent_hits(ctx, {"override", "role-change", "exfiltration", "do-not-tell-user", "addressed-to-ai"})
    if not hits:
        return
    hits = hits[:3]
    yield Match(
        rule="agent.override-phrases",
        category="agent-instructions",
        severity="high",
        title="An agent instruction file contains text that overrides an agent's rules",
        path=ctx.path,
        start=hits[0].line,
        end=hits[-1].line,
        flags=[(h.line, h.line, "This text tries to override an agent's own rules, change its role, or hide something from the user.") for h in hits],
        decoys=decoy_ranges(ctx.lines, re.compile(r"(?i)\b(?:style|convention|format|naming)\b"), "An ordinary note about code style.", {h.line for h in hits}),
        fix="Instruction files should describe the project, not argue with the agent. Remove the override and keep only build, test and style guidance.",
        evidence=short(ctx.lines[hits[0].line - 1]),
    )


def _prose_scan(path: str) -> bool:
    return (is_prose(path) or re.search(r"(?i)(^|/)(readme|contributing|changelog)", path) is not None) and not is_test_path(path) and not is_agent_file(path)


@rule("content.text-for-ai-readers", "prompt-injection", "medium", _prose_scan)
def text_for_ai(ctx: FileCtx) -> Iterable[Match]:
    hits = one_per_line([h for h in find_injections(ctx.text) if h.kind != "tool-call"])[:3]
    if not hits:
        return
    hidden = any(h.hidden for h in hits)
    yield Match(
        rule="content.text-for-ai-readers",
        category="prompt-injection",
        severity="high" if hidden else "medium",
        title="A file has text written for AI readers" + (", hidden from people" if hidden else ""),
        path=ctx.path,
        start=hits[0].line,
        end=hits[-1].line,
        flags=[(h.line, h.line, "Text addressed to an AI reader" + (", and hidden from people who read the page. " if h.hidden else ". ") + "Real documentation never talks to the assistant that reads it.") for h in hits],
        decoys=decoy_ranges(ctx.lines, re.compile(r"(?i)^#+\s|^\s*[-*]\s+\S|^\s*`{3}"), "An ordinary heading, list item or code block.", {h.line for h in hits}),
        fix="Remove the text. Treat anything addressed to an AI as untrusted, and show readers only what is meant for readers.",
        evidence=short(ctx.lines[hits[0].line - 1]),
    )
