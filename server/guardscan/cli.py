"""Command line: scan a folder or a public GitHub repository, read a website or a pasted profile, and bake the demos.

    python -m guardscan.cli demo --out ../public/demo-report.json [--model]   (then copy it to demo/demo-report.json)
    python -m guardscan.cli dir PATH --repo owner/name [--out report.json] [--offline] [--fail-on high]
    python -m guardscan.cli url github.com/owner/repo [--out report.json]
    python -m guardscan.cli site example.com [--out report.json]
    python -m guardscan.cli profile --file profile.txt [--role "Backend engineer"] [--out report.json]
    python -m guardscan.cli bake-demos --out-dir demo [--model]                 (the planted site and profile)
    python -m guardscan.cli serve-demo-site --port 8787                          (a planted site on 127.0.0.1, for the e2e run)

A local .env is read if there is one (GEMINI_API_KEY, SEARXNG_URL). Add --model to let Gemini write the prose.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from typing import Any

from . import ignore
from .assess.nova import AdkNova, NullNova
from .assess.orchestrator import AssessServices, assess
from .assess.search import SearxClient
from .coach import AdkCoach, NullCoach
from .demo import SHA, write_demo
from .demo_site import DEMO_HOST, DEMO_ROLE, demo_profile_text, mock_client_factory, serve_forever
from .envfile import gemini_keys, load_env
from .guard.budget import KillSwitch
from .llm import backup_configured
from .pipeline import Services, scan, scan_dir
from .tools.osv import OsvClient
from .tools.web import WebFetcher


def _write(report: dict[str, Any], out: str | None) -> None:
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        print(f"wrote {out} ({len(report['findings'])} findings)")
    else:
        print(text)


def _coach(model: bool):  # type: ignore[no-untyped-def]
    if model and not (gemini_keys() or backup_configured()):
        raise SystemExit("--model needs GEMINI_API_KEY (in the environment or a .env file)")
    return AdkCoach(KillSwitch()) if model else NullCoach()


async def _demo(out: str | None, offline: bool, model: bool = False) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = write_demo(tmp)
        svc = Services(osv=None if offline else OsvClient(), coach=_coach(model))
        report = await scan_dir(path, "demo/vulnerable-demo", SHA, svc)
        report["demo"] = True
        _write(report, out)


# ------------------------------------------------------------------ website and profile

def _assess_services(model: bool, fetcher=None) -> AssessServices:  # type: ignore[no-untyped-def]
    if model and not (gemini_keys() or backup_configured()):
        raise SystemExit("--model needs GEMINI_API_KEY (in the environment or a .env file)")
    kill = KillSwitch()
    svc = AssessServices(search=SearxClient.from_env(), nova=AdkNova(kill) if model else NullNova(), kill=kill)
    if fetcher is not None:
        svc.make_fetcher = fetcher
    return svc


async def _run_assess(kind: str, payload: dict[str, Any], svc: AssessServices, out: str | None, *, quiet: bool = False) -> dict[str, Any]:
    result: dict[str, Any] | None = None
    async for event, data in assess(kind, payload, svc):
        if event == "log" and not quiet:
            print(f"[{data.get('from', '-'):>10}] {data['text']}", file=sys.stderr)
        elif event == "error":
            raise SystemExit(data["message"])
        elif event == "report":
            result = data
    assert result is not None
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {out} ({len(result['findings'])} findings, {len(result['questions'])} questions)")
    return result


async def _bake_demos(out_dir: str, model: bool) -> None:
    """Runs the planted site (from memory, as https://brightside-bakery.example) and the planted profile, and writes the reports."""
    site_svc = _assess_services(model, lambda: WebFetcher(mock_client_factory(), delay=0))
    site = await _run_assess("site", {"url": DEMO_HOST}, site_svc, None, quiet=True)
    site["demo"] = True
    profile_svc = _assess_services(model)
    profile_svc.search = None  # the demo must not depend on a search server
    profile = await _run_assess("profile", {"text": demo_profile_text(), "role": DEMO_ROLE}, profile_svc, None, quiet=True)
    profile["demo"] = True
    os.makedirs(out_dir, exist_ok=True)
    for name, report in (("demo-site-report.json", site), ("demo-profile-report.json", profile)):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {path} ({len(report['findings'])} findings, {len(report['questions'])} questions, model={report['model']})")


SEVERITIES = ["info", "low", "medium", "high", "critical"]


def _gate(report: dict[str, Any], fail_on: str | None) -> int:
    """Exit status for CI: 1 when a real (not benign) finding is at or above the chosen severity."""
    if not fail_on:
        return 0
    floor = SEVERITIES.index(fail_on)
    bad = [f for f in report["findings"] if not f.get("benign") and SEVERITIES.index(f["severity"]) >= floor]
    for f in bad:
        print(f"{f['severity'].upper():8} {f['path']}:{f['startLine']}  {f['rule']}  {f['title']}", file=sys.stderr)
    if bad:
        print(f"{len(bad)} finding(s) at or above '{fail_on}'", file=sys.stderr)
    return 1 if bad else 0


async def _dir(path: str, repo: str, out: str | None, offline: bool, fail_on: str | None, ignore_file: str | None) -> int:
    report = await scan_dir(path, repo, "0" * 40, Services(osv=None if offline else OsvClient()))
    if ignore_file:
        try:
            with open(ignore_file, encoding="utf-8") as fh:
                rules = ignore.parse(fh.read())
        except (OSError, ignore.IgnoreError) as err:
            print(f"{ignore_file}: {err}", file=sys.stderr)
            return 2
        report["findings"], accepted, stale = ignore.apply(report["findings"], rules)
        for f, rule in accepted:
            print(f"accepted  {f['path']}:{f['startLine']}  {f['rule']}  ({rule.reason})", file=sys.stderr)
        for rule in stale:
            print(f"stale entry (matches nothing): line {rule.line}: {rule.rule} {rule.path}", file=sys.stderr)
    _write(report, out)
    return _gate(report, fail_on)


async def _url(url: str, out: str | None) -> None:
    result: dict[str, Any] | None = None
    async for kind, data in scan(url, Services(osv=OsvClient())):
        if kind == "log":
            print(data["text"], file=sys.stderr)
        elif kind == "error":
            raise SystemExit(data["message"])
        else:
            result = data
    assert result is not None
    _write(result, out)


def main() -> None:
    load_env()
    p = argparse.ArgumentParser(prog="guardscan")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="scan the built-in demo repository")
    d.add_argument("--out")
    d.add_argument("--offline", action="store_true", help="do not ask OSV about dependencies")
    d.add_argument("--model", action="store_true", help="let Gemini write the prose (needs GEMINI_API_KEY)")
    s = sub.add_parser("site", help="read a public website passively and report")
    s.add_argument("url")
    s.add_argument("--out")
    s.add_argument("--model", action="store_true")
    pf = sub.add_parser("profile", help="analyse a profile that you pasted into a text file")
    pf.add_argument("--file", required=True)
    pf.add_argument("--role", default="")
    pf.add_argument("--out")
    pf.add_argument("--model", action="store_true")
    b = sub.add_parser("bake-demos", help="run the planted demo site and profile and write their reports")
    b.add_argument("--out-dir", default="demo")
    b.add_argument("--model", action="store_true")
    ds = sub.add_parser("serve-demo-site", help="serve the planted demo website on 127.0.0.1 (for the end-to-end run)")
    ds.add_argument("--port", type=int, default=8787)
    r = sub.add_parser("dir", help="scan a folder named OWNER__REPO")
    r.add_argument("path")
    r.add_argument("--repo", required=True, help="owner/name, used in the report")
    r.add_argument("--out")
    r.add_argument("--offline", action="store_true")
    r.add_argument("--fail-on", choices=SEVERITIES[1:], help="exit with status 1 if a finding is at or above this severity (for CI)")
    r.add_argument("--ignore-file", help="accepted findings, each with a reason (see guardscan/ignore.py); for your own checkout only")
    w = sub.add_parser("write-demo", help="write the demo repository into a folder, for the test source")
    w.add_argument("dir")
    u = sub.add_parser("url", help="scan a public GitHub repository")
    u.add_argument("url")
    u.add_argument("--out")
    args = p.parse_args()
    if args.cmd == "write-demo":
        os.makedirs(args.dir, exist_ok=True)
        print(write_demo(args.dir))
    elif args.cmd == "demo":
        asyncio.run(_demo(args.out, args.offline, args.model))
    elif args.cmd == "site":
        asyncio.run(_run_assess("site", {"url": args.url}, _assess_services(args.model), args.out))
    elif args.cmd == "profile":
        with open(args.file, encoding="utf-8") as fh:
            text = fh.read()
        asyncio.run(_run_assess("profile", {"text": text, "role": args.role}, _assess_services(args.model), args.out))
    elif args.cmd == "bake-demos":
        asyncio.run(_bake_demos(args.out_dir, args.model))
    elif args.cmd == "serve-demo-site":
        serve_forever(args.port)
    elif args.cmd == "dir":
        raise SystemExit(asyncio.run(_dir(args.path, args.repo, args.out, args.offline, args.fail_on, args.ignore_file)))
    else:
        asyncio.run(_url(args.url, args.out))


if __name__ == "__main__":
    main()
