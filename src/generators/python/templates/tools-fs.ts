import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsFsPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "File tools: read, write, list and search files under a confined root.")}

from __future__ import annotations

import os
import re
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from ..config import (
    ALLOWED_PATHS,
    FS_DEFAULT_MAX_BYTES,
    IGNORED_DIRS,
    LIST_MAX_RESULTS,
    SEARCH_MAX_FILE_BYTES,
    SEARCH_MAX_MATCHES,
)
from .base import ToolResult, redact

#: read_file reads this many bytes past maxBytes so redaction sees a secret that straddles the cut.
REDACT_MARGIN = 4096
#: A directory holding this file is decree's generated output: list_files and search skip it.
GENERATED_MARKER = ".decree-generated"
_generated_dirs: dict[Path, bool] = {}


class PathError(ValueError):
    """A path the model asked for is outside what the tool may touch."""


# --------------------------------------------------------------------------
# Path confinement
# --------------------------------------------------------------------------


def tool_root(binding: Mapping[str, Any], project_root: Path) -> Path:
    return (project_root / str(binding.get("root") or ".")).resolve()


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def is_allowed(path: Path, project_root: Path) -> bool:
    """True when the path is under one of ALLOWED_PATHS (no entries = no extra restriction)."""
    roots = [(project_root / allowed).resolve() for allowed in ALLOWED_PATHS]
    return not roots or any(_within(path, root) for root in roots)


def resolve_path(binding: Mapping[str, Any], project_root: Path, rel: object) -> Path:
    """Resolve a model-supplied path against the tool root, refusing anything that escapes it."""
    if not isinstance(rel, str) or not rel.strip() or "\x00" in rel:
        raise PathError("A non-empty 'path' string is required.")
    base = tool_root(binding, project_root)
    lexical = Path(os.path.normpath(base / rel))
    if not _within(lexical, base):
        raise PathError(f"Refused: {rel!r} escapes the tool root.")
    real = lexical.resolve()  # follows symlinks for whatever part of the path exists
    if not _within(real, base):
        raise PathError(f"Refused: {rel!r} resolves outside the tool root (symlink).")
    if not is_allowed(real, project_root):
        raise PathError(f"Refused: {rel!r} is outside the allowed paths.")
    return real


def display(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix() or "."
    except ValueError:
        return path.as_posix()


# --------------------------------------------------------------------------
# Globs (fast-glob style: "*" stays within a segment, "**/" spans directories)
# --------------------------------------------------------------------------


def _translate(pattern: str) -> str:
    out: list[str] = []
    i, n = 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern.startswith("**", i):
                i += 2
                if i < n and pattern[i] == "/":
                    out.append("(?:.*/)?")
                    i += 1
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            end = pattern.find("]", i + 2)
            if end == -1:
                out.append(re.escape(c))
            else:
                body = pattern[i + 1 : end]
                negate = body[:1] in ("!", "^")
                if negate:
                    body = body[1:]
                out.append("[" + ("^" if negate else "") + body.replace("\\", "\\\\") + "]")
                i = end
        elif c == "{":
            end = pattern.find("}", i)
            if end == -1:
                out.append(re.escape(c))
            else:
                options = pattern[i + 1 : end].split(",")
                out.append("(?:" + "|".join(_translate(option) for option in options) + ")")
                i = end
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Compile a glob into a regex matched against POSIX paths relative to the root."""
    return re.compile(r"\A" + _translate(pattern) + r"\Z", re.DOTALL)


def _static_prefix(pattern: str) -> str:
    """Leading directory segments without glob characters (lets the walk start deeper)."""
    parts = pattern.split("/")[:-1]
    prefix: list[str] = []
    for part in parts:
        if any(ch in part for ch in "*?[{"):
            break
        prefix.append(part)
    return "/".join(prefix)


def is_generated_dir(path: Path) -> bool:
    """Whether the directory holds the .decree-generated marker (cached per directory)."""
    hit = _generated_dirs.get(path)
    if hit is None:
        hit = _generated_dirs[path] = (path / GENERATED_MARKER).is_file()
    return hit


def walk_files(base: Path, start: Path) -> Iterator[Path]:
    """Every file under start, sorted, skipping IGNORED_DIRS, generated output and symlinked directories."""
    if not start.is_dir():
        return
    # The walk may start below base (a glob's static prefix): directories on the way down count too.
    try:
        between = start.relative_to(base).parts
    except ValueError:
        between = ()
    for i in range(1, len(between) + 1):
        if is_generated_dir(base.joinpath(*between[:i])):
            return
    for dirpath, dirnames, filenames in os.walk(start):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not is_generated_dir(Path(dirpath) / d))
        for name in sorted(filenames):
            yield Path(dirpath) / name


def _normalize_pattern(pattern: str) -> str:
    pattern = pattern.strip().replace("\\", "/")
    while pattern.startswith("./"):
        pattern = pattern[2:]
    return pattern or "**/*"


def iter_matches(binding: Mapping[str, Any], project_root: Path, pattern: str) -> Iterator[tuple[Path, str]]:
    """(absolute path, display path) for every file under the tool root matching the glob."""
    base = tool_root(binding, project_root)
    pattern = _normalize_pattern(pattern)
    if pattern.startswith("/") or ".." in pattern.split("/"):
        raise PathError("Refused: glob patterns must be relative and stay inside the tool root.")
    regex = glob_to_regex(pattern)
    start = Path(os.path.normpath(base / _static_prefix(pattern)))
    for path in walk_files(base, start):
        rel = display(path, base)
        if regex.match(rel) and is_allowed(path.resolve(), project_root) and _within(path.resolve(), base):
            yield path, rel


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------


def read_file(binding: Mapping[str, Any], args: Mapping[str, Any], project_root: Path) -> ToolResult:
    try:
        path = resolve_path(binding, project_root, args.get("path"))
    except PathError as exc:
        return ToolResult.error(str(exc))
    rel = args.get("path")
    if not path.exists():
        return ToolResult.error(f"File not found: {rel}")
    if path.is_dir():
        return ToolResult.error(f"{rel} is a directory; list it with a glob instead.")
    max_bytes = int(binding.get("maxBytes") or FS_DEFAULT_MAX_BYTES)
    size = path.stat().st_size
    # Read a margin past the limit and redact BEFORE cutting, so no fragment of a secret survives the cut.
    with path.open("rb") as handle:
        data = handle.read(max_bytes + REDACT_MARGIN)
    out = redact(data.decode("utf-8", errors="replace")).encode("utf-8")
    # When the file was not read to the end, the last REDACT_MARGIN bytes may start a secret that
    # continues past what was read; always cut them.
    keep = max_bytes if len(data) >= size else max(0, min(max_bytes, len(out) - REDACT_MARGIN))
    if len(out) <= keep:
        return ToolResult(out.decode("utf-8", errors="replace"))
    text = out[:keep].decode("utf-8", errors="replace")
    text += f"\n…[truncated {len(out) - keep + size - len(data)} bytes]"
    return ToolResult(text)


def write_file(binding: Mapping[str, Any], args: Mapping[str, Any], project_root: Path) -> ToolResult:
    content = args.get("content")
    if not isinstance(content, str):
        return ToolResult.error("A 'content' string is required.")
    try:
        path = resolve_path(binding, project_root, args.get("path"))
    except PathError as exc:
        return ToolResult.error(str(exc))
    if path.is_dir():
        return ToolResult.error(f"{args.get('path')} is a directory.")
    data = content.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return ToolResult(f"wrote {len(data)} bytes to {display(path, tool_root(binding, project_root))}")


def list_files(binding: Mapping[str, Any], args: Mapping[str, Any], project_root: Path) -> ToolResult:
    pattern = args.get("pattern")
    if pattern is not None and not isinstance(pattern, str):
        return ToolResult.error("'pattern' must be a glob string.")
    lines: list[str] = []
    extra = 0
    try:
        for _, rel in iter_matches(binding, project_root, pattern or "**/*"):
            if len(lines) < LIST_MAX_RESULTS:
                lines.append(rel)
            else:
                extra += 1
    except PathError as exc:
        return ToolResult.error(str(exc))
    if not lines:
        return ToolResult(f"No files match {pattern or '**/*'!r}.")
    if extra:
        lines.append(f"…[truncated: {extra} more files; narrow the pattern]")
    return ToolResult("\n".join(lines))


def search(binding: Mapping[str, Any], args: Mapping[str, Any], project_root: Path) -> ToolResult:
    query = args.get("query")
    if not isinstance(query, str) or not query:
        return ToolResult.error("A non-empty 'query' regular expression is required.")
    try:
        regex = re.compile(query)
    except re.error as exc:
        return ToolResult.error(f"Invalid regular expression: {exc}")
    glob = args.get("glob")
    matches: list[str] = []
    try:
        for path, rel in iter_matches(binding, project_root, glob if isinstance(glob, str) and glob else "**/*"):
            try:
                if path.stat().st_size > SEARCH_MAX_FILE_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            if b"\x00" in data[:8192]:
                continue  # binary
            for lineno, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), start=1):
                if regex.search(line):
                    matches.append(f"{rel}:{lineno}: {line.strip()[:300]}")
                    if len(matches) >= SEARCH_MAX_MATCHES:
                        matches.append(f"…[stopped at {SEARCH_MAX_MATCHES} matches; refine the query or glob]")
                        return ToolResult("\n".join(matches))
    except PathError as exc:
        return ToolResult.error(str(exc))
    return ToolResult("\n".join(matches) if matches else f"No matches for {query!r}.")
`;
}
