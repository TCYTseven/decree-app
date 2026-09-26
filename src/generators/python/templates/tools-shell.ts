import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsShellPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "Shell tools: run templated commands (scripts, make targets, CLIs) in the project.")}

from __future__ import annotations

import os
import re
import signal
import subprocess
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from ..config import BLOCKED_COMMANDS, SHELL_DEFAULT_TIMEOUT_MS, SHELL_MAX_OUTPUT_CHARS
from .base import ToolResult, to_text, truncate_tail

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_-]+)\s*\}\}")
_SENTINEL = "\x00{}\x00"


def sh_quote(value: str) -> str:
    """POSIX single-quote escaping: always quoted, embedded quotes become '\''."""
    return "'" + value.replace("'", "'\\''") + "'"


def render_command(template: str, args: Mapping[str, Any]) -> str:
    """Fill {{param}} placeholders with shell-escaped input values.

    Missing (or null) parameters become empty strings, and the resulting runs of
    spaces in the template text are collapsed. Substituted values are never
    touched by that cleanup.
    """
    values: list[str] = []

    def fill(match: re.Match[str]) -> str:
        value = args.get(match.group(1))
        if value is None:
            return ""
        values.append(sh_quote(to_text(value)))
        return _SENTINEL.format(len(values) - 1)

    skeleton = re.sub(r" {2,}", " ", _PLACEHOLDER.sub(fill, template)).strip()
    return re.sub(r"\x00(\d+)\x00", lambda m: values[int(m.group(1))], skeleton)


def blocked_pattern(command: str, blocked: Iterable[str]) -> str | None:
    """The first blocked substring found in the command, if any."""
    return next((pattern for pattern in blocked if pattern and pattern in command), None)


def run_shell(binding: Mapping[str, Any], args: Mapping[str, Any], project_root: Path) -> ToolResult:
    """Run a shell tool with /bin/sh -c. Result text is 'exit code: <n>' then combined output."""
    command = render_command(str(binding.get("command") or ""), args)
    pattern = blocked_pattern(command, BLOCKED_COMMANDS)
    if pattern is not None:
        return ToolResult.error(f"Refused: the command contains a blocked pattern ({pattern!r}).")
    cwd = (project_root / str(binding.get("cwd") or ".")).resolve()
    if not cwd.is_dir():
        return ToolResult.error(f"Working directory does not exist: {cwd}")
    timeout_s = (binding.get("timeoutMs") or SHELL_DEFAULT_TIMEOUT_MS) / 1000
    return run_command(command, cwd, timeout_s)


def run_command(command: str, cwd: Path, timeout_s: float) -> ToolResult:
    """Run a command in its own process group so a timeout kills the whole tree."""
    try:
        proc = subprocess.Popen(
            ["/bin/sh", "-c", command],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        return ToolResult.error(f"Failed to start command: {exc}")
    try:
        raw, _ = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        raw, _ = proc.communicate()
        output = truncate_tail(raw.decode("utf-8", errors="replace"), SHELL_MAX_OUTPUT_CHARS)
        return ToolResult.error(f"exit code: timeout after {timeout_s:g}s\n{output}")
    except BaseException:
        _kill_group(proc)
        raise
    output = truncate_tail(raw.decode("utf-8", errors="replace"), SHELL_MAX_OUTPUT_CHARS)
    return ToolResult(f"exit code: {proc.returncode}\n{output}", proc.returncode != 0)


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()
`;
}
