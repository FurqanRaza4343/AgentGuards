"""The command line, the accepted-findings file and the CI gate."""

from __future__ import annotations

import json
import os

import pytest

from guardscan import cli, ignore
from guardscan.demo import write_demo


def finding(rule: str, path: str, severity: str = "high", benign: bool = False) -> dict:
    return {"rule": rule, "path": path, "severity": severity, "benign": benign, "startLine": 1, "title": "t"}


# ------------------------------------------------------------------ the accepted-findings file

def test_a_line_needs_a_reason() -> None:
    with pytest.raises(ignore.IgnoreError, match="reason"):
        ignore.parse("secret.* tests/**\n")
    with pytest.raises(ignore.IgnoreError, match="reason"):
        ignore.parse("secret.* tests/** -- x\n")  # too short to explain anything
    with pytest.raises(ignore.IgnoreError, match="expected"):
        ignore.parse("secret.* -- fake keys used to test the masking\n")


def test_comments_and_blank_lines_are_skipped() -> None:
    rules = ignore.parse("# why this file exists\n\nsecret.* tests/** -- fake keys used to test the masking\n")
    assert len(rules) == 1 and rules[0].line == 3 and rules[0].reason == "fake keys used to test the masking"


def test_apply_keeps_what_is_not_accepted_and_reports_stale_entries() -> None:
    rules = ignore.parse("secret.* tests/** -- fake keys used to test the masking\ninjection.* gone/** -- a file that no longer exists\n")
    findings = [finding("secret.hardcoded", "tests/a.py"), finding("secret.hardcoded", "src/config.py"), finding("injection.eval-exec", "tests/a.py")]
    kept, accepted, stale = ignore.apply(findings, rules)
    assert [f["path"] for f in kept] == ["src/config.py", "tests/a.py"] and kept[1]["rule"] == "injection.eval-exec"
    assert len(accepted) == 1 and accepted[0][1].line == 1
    assert [s.path for s in stale] == ["gone/**"]


# ------------------------------------------------------------------ the gate

def test_the_gate_fails_on_real_findings_at_or_above_the_level_and_ignores_benign_ones() -> None:
    report = {"findings": [finding("a", "x", "medium"), finding("b", "y", "critical", benign=True)]}
    assert cli._gate(report, None) == 0
    assert cli._gate(report, "high") == 0  # the critical one is benign (a look-alike that is safe)
    assert cli._gate(report, "medium") == 1
    assert cli._gate({"findings": []}, "low") == 0


# ------------------------------------------------------------------ a whole run on a folder of any name

async def test_a_checkout_with_any_folder_name_can_be_scanned_and_gated(tmp_path, capsys: pytest.CaptureFixture[str]) -> None:  # type: ignore[no-untyped-def]
    checkout = tmp_path / "my-checkout"
    checkout.mkdir()
    write_demo(str(tmp_path / "x"))
    src = tmp_path / "x" / "demo__vulnerable-demo"
    for root, _dirs, files in os.walk(src):
        for name in files:
            target = checkout / os.path.relpath(os.path.join(root, name), src)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(open(os.path.join(root, name), "rb").read())

    out = tmp_path / "report.json"
    assert await cli._dir(str(checkout), "me/my-checkout", str(out), True, "high", None) == 1
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["repo"] == "me/my-checkout" and len(report["findings"]) >= 10

    # accept every finding with a reason: the gate passes and the run says what it accepted
    accepted = tmp_path / ".agentguard-ignore"
    accepted.write_text("* ** -- this is the deliberately vulnerable demo repository\n", encoding="utf-8")
    assert await cli._dir(str(checkout), "me/my-checkout", str(out), True, "high", str(accepted)) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["findings"] == []
    assert "accepted" in capsys.readouterr().err

    # a malformed file is an error, not a silent pass
    accepted.write_text("* **\n", encoding="utf-8")
    assert await cli._dir(str(checkout), "me/my-checkout", str(out), True, "high", str(accepted)) == 2


async def test_a_folder_that_does_not_exist_is_refused() -> None:
    from guardscan.pipeline import scan_dir

    with pytest.raises(ValueError, match="not a directory"):
        await scan_dir("/no/such/folder", "a/b")
