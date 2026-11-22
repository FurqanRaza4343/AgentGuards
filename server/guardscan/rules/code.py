"""Injection flaws in code: a command or query built by gluing in text, and its safe forms."""

from __future__ import annotations

import re
from collections.abc import Iterable

from .base import MAX_LINE, FileCtx, Match, decoy_ranges, find_lines, is_test_path, rule, short

GLUE = r"""(?:\+|f["']|\.format\(|%\s*[\(\w]|\$\{|`[^`]*\$\{)"""

PY = lambda p: p.endswith(".py") and not is_test_path(p)  # noqa: E731
JS = lambda p: re.search(r"\.(?:js|jsx|ts|tsx|mjs|cjs)$", p) is not None and not is_test_path(p)  # noqa: E731
RS = lambda p: p.endswith(".rs") and not is_test_path(p)  # noqa: E731
GO = lambda p: p.endswith(".go") and not is_test_path(p)  # noqa: E731

OS_SYSTEM = re.compile(r"\bos\.(?:system|popen)\(\s*(?P<arg>[^\n]*)")
SUBPROC = re.compile(r"\bsubprocess\.(?:run|call|Popen|check_output|check_call)\(")
EVAL_PY = re.compile(r"(?<![\w.])(?:eval|exec)\(\s*(?!['\"]|\d)[^\n)]+\)")
UNSAFE_LOAD = re.compile(r"\bpickle\.loads?\(|\byaml\.load\((?![^)\n]*Loader)")
STR = r"""(?:"[^"\n]*"|'[^'\n]*')"""  # a string literal, which may hold the other kind of quote
SQL_PY = re.compile(rf"""\.execute(?:many)?\(\s*(?:f["']|{STR}\s*(?:\+|%)|{STR}\.format\()""")
SQL_PARAM = re.compile(rf"""\.execute(?:many)?\(\s*(?:"[^"\n]*(?:%s|\?|:\w+)[^"\n]*"|'[^'\n]*(?:%s|\?|:\w+)[^'\n]*')\s*,\s*[\(\[\{{\w]""")
LIST_ARGV = re.compile(r"\bsubprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[")
SHELL_TRUE = re.compile(r"shell\s*=\s*True")
EXEC_JS = re.compile(r"\b(?:child_process\.)?exec(?:Sync)?\(\s*(?:`[^`\n]*\$\{|[\"'][^\"'\n]*[\"']\s*\+|\w+\s*\+)")
EVAL_JS = re.compile(r"(?<![\w.])eval\(\s*(?![\"'`]|\d)[^\n)]+\)|new Function\(\s*(?![\"'`])")
SQL_JS = re.compile(rf"""\.(?:query|execute|raw)\(\s*(?:`[^`\n]*\$\{{|{STR}\s*\+)""")
SAFE_JS = re.compile(r"\b(?:execFile(?:Sync)?|spawn(?:Sync)?)\(\s*[\"'][^\"']+[\"']\s*,\s*\[")
SHELL_RS = re.compile(r"""Command::new\(\s*["'](?:sh|bash|cmd)["']\s*\)[^;\n]*\.args?\(\s*(?:\[\s*)?["'](?:-c|/C)["'][^;\n]*(?:format!|\+)""")
SHELL_GO = re.compile(r"""exec\.Command\(\s*["'](?:sh|bash)["']\s*,\s*["']-c["']\s*,\s*(?!["'`])""")


def _m(ctx: FileCtx, rule_id: str, sev: str, title: str, n: int, note: str, fix: str, decoy: tuple[re.Pattern[str], str] | None = None) -> Match:
    return Match(
        rule=rule_id,
        category="injection",
        severity=sev,
        title=title,
        path=ctx.path,
        start=n,
        end=n,
        flags=[(n, n, note)],
        decoys=decoy_ranges(ctx.lines, decoy[0], decoy[1], {n}) if decoy else [],
        fix=fix,
        evidence=short(ctx.lines[n - 1]),
    )


@rule("injection.os-system-concat", "injection", "high", PY)
def os_system(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, OS_SYSTEM):
        arg = OS_SYSTEM.search(ctx.lines[n - 1]).group("arg")  # type: ignore[union-attr]
        if re.search(GLUE, arg):
            yield _m(ctx, "injection.os-system-concat", "high", "A shell command is built from outside text", n,
                     "The command is built by joining text into a shell string, so that text can change what the command does.",
                     "Validate the input, and run the program with an argument list (subprocess.run([...])) instead of a shell string.",
                     (LIST_ARGV, "A command run with an argument list, which does not go through a shell. This is the safe form."))
            return


@rule("injection.subprocess-shell", "injection", "high", PY)
def subprocess_shell(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, SUBPROC):
        call = "\n".join(ctx.lines[n - 1 : n + 3])
        if SHELL_TRUE.search(call) and re.search(GLUE, call.split("shell", 1)[0]):
            yield _m(ctx, "injection.subprocess-shell", "high", "A shell command is built from outside text", n,
                     "shell=True with a command built from text lets that text run extra commands.",
                     "Pass the command as a list and drop shell=True.",
                     (LIST_ARGV, "A command run with an argument list, which does not go through a shell. This is the safe form."))
            return


@rule("injection.eval-exec", "injection", "high", PY)
def eval_exec(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, EVAL_PY)[:1]:
        yield _m(ctx, "injection.eval-exec", "high", "Code is run from a value that is not a literal", n,
                 "eval or exec runs whatever text it is given, so any text that reaches here can run as code.",
                 "Parse the data with a real parser (json, ast.literal_eval) instead of running it.",
                 (re.compile(r"ast\.literal_eval\("), "ast.literal_eval only reads literals and cannot run code. This is the safe form."))


@rule("injection.unsafe-deserialisation", "injection", "high", PY)
def unsafe_load(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, UNSAFE_LOAD)[:1]:
        yield _m(ctx, "injection.unsafe-deserialisation", "high", "Data is loaded in a way that can run code", n,
                 "pickle and yaml.load without a safe loader can run code that is hidden inside the data.",
                 "Use json, or yaml.safe_load, and never unpickle data from outside.",
                 (re.compile(r"yaml\.safe_load\(|json\.loads?\("), "A loader that only reads data and cannot run code. This is the safe form."))


@rule("injection.sql-concat", "injection", "high", PY)
def sql_py(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, SQL_PY)[:1]:
        yield _m(ctx, "injection.sql-concat", "high", "A database query is built from outside text", n,
                 "The query is built by joining text into the SQL string, so that text can change the query.",
                 "Use query parameters: pass the values as a separate argument so the database treats them as data.",
                 (SQL_PARAM, "A parameterised query: the values travel separately from the SQL. This is the safe form."))


@rule("injection.argument-list", "injection", "info", PY)
def argument_list(ctx: FileCtx) -> Iterable[Match]:
    """The safe forms, kept as legitimate requests."""
    for n in find_lines(ctx.lines, LIST_ARGV):
        call = "\n".join(ctx.lines[n - 1 : n + 3])
        if not SHELL_TRUE.search(call):
            yield Match(rule="injection.argument-list", category="injection", severity="info", title="A command run with an argument list", path=ctx.path,
                        start=n, end=n, flags=[(n, n, "The command is an argument list, not a shell string, so outside text cannot change the command.")],
                        fix="Nothing to change.", evidence=short(ctx.lines[n - 1]), benign=True)
            return
    for n in find_lines(ctx.lines, SQL_PARAM):
        yield Match(rule="injection.argument-list", category="injection", severity="info", title="A parameterised database query", path=ctx.path,
                    start=n, end=n, flags=[(n, n, "The values travel separately from the SQL, so the database treats them as data.")],
                    fix="Nothing to change.", evidence=short(ctx.lines[n - 1]), benign=True)
        return


@rule("injection.js-command", "injection", "high", JS)
def js_exec(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, EXEC_JS)[:1]:
        yield _m(ctx, "injection.js-command", "high", "A shell command is built from outside text", n,
                 "exec runs a shell string, and the string is built by joining in text, so that text can add commands.",
                 "Use execFile or spawn with an array of arguments, which does not go through a shell.",
                 (SAFE_JS, "execFile or spawn with an argument array. This is the safe form."))


@rule("injection.js-eval", "injection", "high", JS)
def js_eval(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, EVAL_JS)[:1]:
        yield _m(ctx, "injection.js-eval", "high", "Code is run from a value that is not a literal", n,
                 "eval and new Function run whatever text they are given, so any text that reaches here can run as code.",
                 "Parse the data with JSON.parse or a proper parser instead of running it.",
                 (re.compile(r"JSON\.parse\("), "JSON.parse only reads data and cannot run code. This is the safe form."))


@rule("injection.js-sql", "injection", "high", JS)
def js_sql(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, SQL_JS)[:1]:
        yield _m(ctx, "injection.js-sql", "high", "A database query is built from outside text", n,
                 "The query is built by joining text into the SQL string, so that text can change the query.",
                 "Use placeholders and pass the values as a separate argument.",
                 (re.compile(r"""\.(?:query|execute)\(\s*["'][^"'\n]*(?:\$\d|\?)[^"'\n]*["']\s*,\s*\["""), "A parameterised query. This is the safe form."))


@rule("injection.shell-c", "injection", "high", lambda p: RS(p) or GO(p))
def shell_c(ctx: FileCtx) -> Iterable[Match]:
    pat = SHELL_RS if ctx.path.endswith(".rs") else SHELL_GO
    for n in find_lines(ctx.lines, pat)[:1]:
        yield _m(ctx, "injection.shell-c", "high", "A shell command is built from outside text", n,
                 "A shell is started with -c and a command that is not a fixed string, so text in it can add commands.",
                 "Start the program directly with an argument list instead of going through a shell.",
                 (re.compile(r"""(?:Command::new|exec\.Command)\(\s*["'][^"']*["']\s*\)?\s*,?\s*\.?args?\(\s*\[|exec\.Command\(\s*["'][^"']+["']\s*,\s*["'][^-]"""), "A program started directly with its arguments, without a shell. This is the safe form."))
