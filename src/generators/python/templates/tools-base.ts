import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsBasePy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "Shared tool types and output hygiene helpers.")}

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from ..config import REDACT_ENV


@dataclass(frozen=True)
class ToolResult:
    """What a tool returns to the model: text plus an error flag."""

    output: str
    is_error: bool = False

    @classmethod
    def error(cls, message: str) -> "ToolResult":
        return cls(message, True)


def truncate_head(text: str, limit: int) -> str:
    """Keep the first *limit* characters, noting how many were dropped."""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…[truncated {len(text) - limit} chars]"


def truncate_tail(text: str, limit: int) -> str:
    """Keep the last *limit* characters (the end of a log is what matters)."""
    if len(text) <= limit:
        return text
    return f"…[truncated {len(text) - limit} chars]\n" + text[-limit:]


def redact(text: str) -> str:
    """Replace the values of REDACT_ENV variables with [REDACTED:<NAME>].

    Values shorter than 4 characters are ignored (they would mangle ordinary text).
    Tools call this before truncating, so a cut never leaves part of a secret behind.
    """
    secrets = [(name, os.environ.get(name, "")) for name in REDACT_ENV]
    # Longest values first so a secret that contains another is scrubbed whole.
    for name, value in sorted(secrets, key=lambda item: len(item[1]), reverse=True):
        if len(value) >= 4:
            text = text.replace(value, f"[REDACTED:{name}]")
    return text


def to_text(value: Any) -> str:
    """Stringify a tool argument the way JavaScript's String() would for JSON values."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)
`;
}
