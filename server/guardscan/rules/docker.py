"""Dockerfiles: run as a non-root user, keep secrets out of the image, and do not run a script nobody has read."""

from __future__ import annotations

import re
from collections.abc import Iterable

from ..guard.mask import looks_like_placeholder, mask_line
from .base import FileCtx, Match, decoy_ranges, find_lines, is_dockerfile, rule, short

FROM = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)(?:\s+AS\s+(?P<name>\S+))?", re.I)
USER = re.compile(r"^\s*USER\s+(?P<user>\S+)", re.I)
CURL_PIPE = re.compile(r"(?i)\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b")
SECRET_ENV = re.compile(r"(?i)^\s*(?:ENV|ARG)\s+(?P<name>\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)\w*)\s*[= ]\s*(?P<value>\S+)")
HARMLESS = re.compile(r"^\s*(?:EXPOSE|WORKDIR|LABEL|COPY|ADD)\b", re.I)


def _stages(lines: list[str]) -> list[tuple[int, str, str | None]]:
    out = []
    for n, line in enumerate(lines, start=1):
        m = FROM.match(line)
        if m:
            out.append((n, m.group("image"), m.group("name")))
    return out


@rule("docker.curl-pipe-shell", "docker", "high", is_dockerfile)
def curl_pipe(ctx: FileCtx) -> Iterable[Match]:
    for n in find_lines(ctx.lines, CURL_PIPE)[:1]:
        yield Match(
            rule="docker.curl-pipe-shell",
            category="docker",
            severity="high",
            title="The image build pipes a download into a shell",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "The build downloads a script and runs it at once, so whoever controls that address controls your image.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"^\s*EXPOSE\b", re.I), "EXPOSE only documents the port. It does not open it to the world.", {n}),
            fix="Download the script, check its hash, then run it. Or install the tool from a pinned package.",
            evidence=short(ctx.lines[n - 1]),
        )


@rule("docker.root-user", "docker", "medium", is_dockerfile)
def root_user(ctx: FileCtx) -> Iterable[Match]:
    stages = _stages(ctx.lines)
    if not stages:
        return
    last = stages[-1][0]
    users = [(n, USER.match(line).group("user")) for n, line in enumerate(ctx.lines, start=1) if n > last and USER.match(line)]  # type: ignore[union-attr]
    if users and users[-1][1].split(":")[0].lower() not in {"root", "0"}:
        return
    if stages[-1][1].lower() == "scratch":
        return
    cmds = find_lines(ctx.lines, re.compile(r"^\s*(?:CMD|ENTRYPOINT)\b", re.I))
    n = cmds[-1] if cmds else last
    flag_note = "The container runs as root. If someone breaks in, they have full control inside the container." if not users else "The last USER is root."
    yield Match(
        rule="docker.root-user",
        category="docker",
        severity="medium",
        title="The container runs as root",
        path=ctx.path,
        start=min(n, last),
        end=max(n, last),
        flags=[(n, n, flag_note)],
        decoys=decoy_ranges(ctx.lines, HARMLESS, "This instruction is ordinary and has nothing to do with who the container runs as.", {n}),
        fix="Create a non-root user and switch to it with a USER instruction before CMD.",
        evidence=short(ctx.lines[n - 1]),
    )


@rule("docker.latest-tag", "docker", "low", is_dockerfile)
def latest_tag(ctx: FileCtx) -> Iterable[Match]:
    stage_names = {name.lower() for _, _, name in _stages(ctx.lines) if name}
    for n, image, _name in _stages(ctx.lines):
        base = image.split("@")[0]
        if "@sha256:" in image or image.lower() in stage_names or base.lower() == "scratch" or "$" in base:
            continue
        tag = base.rsplit(":", 1)[1] if ":" in base.rsplit("/", 1)[-1] else "latest"
        if tag == "latest":
            yield Match(
                rule="docker.latest-tag",
                category="docker",
                severity="low",
                title="A base image is not pinned to a version",
                path=ctx.path,
                start=n,
                end=n,
                flags=[(n, n, "The :latest tag, or no tag at all, changes whenever the image is rebuilt upstream, so you cannot tell what you are shipping.")],
                fix="Pin the base image to a specific version, or better, to its digest.",
                evidence=short(ctx.lines[n - 1]),
            )
            return


@rule("docker.secret-in-env", "docker", "high", is_dockerfile)
def secret_env(ctx: FileCtx) -> Iterable[Match]:
    for n, line in enumerate(ctx.lines, start=1):
        m = SECRET_ENV.match(line)
        if not m:
            continue
        value = m.group("value").strip("\"'")
        if not value or value.startswith("$") or looks_like_placeholder(value):
            continue
        yield Match(
            rule="docker.secret-in-env",
            category="docker",
            severity="high",
            title="A secret is baked into the image",
            path=ctx.path,
            start=n,
            end=n,
            flags=[(n, n, "ENV and ARG values stay in the image layers, so anyone who can pull the image can read this secret.")],
            decoys=decoy_ranges(ctx.lines, re.compile(r"^\s*ENV\s+\w+\s*=?\s*\S*(?:PATH|HOME|LANG|PORT)", re.I), "An ordinary setting with no secret in it.", {n}),
            fix="Pass secrets at run time (a secret manager or an environment variable set by the platform), or use a BuildKit secret mount. Rotate this one.",
            evidence=mask_line(short(line)),
        )
        return


@rule("docker.nonroot-pinned", "docker", "info", is_dockerfile)
def nonroot_ok(ctx: FileCtx) -> Iterable[Match]:
    """The safe form, kept as a legitimate request: a pinned base image and a non-root user."""
    stages = _stages(ctx.lines)
    if not stages:
        return
    last = stages[-1]
    base = last[1]
    if "@sha256:" not in base and (":" not in base.rsplit("/", 1)[-1] or base.endswith(":latest")):
        return
    users = [(n, USER.match(line).group("user")) for n, line in enumerate(ctx.lines, start=1) if n > last[0] and USER.match(line)]  # type: ignore[union-attr]
    if not users or users[-1][1].split(":")[0].lower() in {"root", "0"}:
        return
    n = users[-1][0]
    yield Match(
        rule="docker.nonroot-pinned",
        category="docker",
        severity="info",
        title="A container that runs as a non-root user from a pinned image",
        path=ctx.path,
        start=min(n, last[0]),
        end=max(n, last[0]),
        flags=[(last[0], last[0], "The base image is pinned to a version."), (n, n, "The container switches to a non-root user.")],
        fix="Nothing to change.",
        evidence=short(ctx.lines[n - 1]),
        benign=True,
    )
