import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsMemoryPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "Client-side backend for Anthropic's memory tool (memory_20250818).")}

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .base import ToolResult

VIRTUAL_ROOT = "/memories"


class MemoryStore:
    """Files under a local directory, addressed by the model as /memories/..."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    # -- paths ---------------------------------------------------------------

    def _resolve(self, virtual: object) -> Path:
        if not isinstance(virtual, str) or "\x00" in virtual:
            raise ValueError("A 'path' string under /memories is required.")
        path = virtual.strip().replace("\\", "/")
        if path != VIRTUAL_ROOT and not path.startswith(VIRTUAL_ROOT + "/"):
            raise ValueError(f"Paths must start with {VIRTUAL_ROOT}: {virtual!r}")
        rel = path[len(VIRTUAL_ROOT) :].lstrip("/")
        target = Path(os.path.normpath(self.root / rel)) if rel else self.root
        resolved = target.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise ValueError(f"Refused: {virtual!r} escapes the memory directory.")
        return resolved

    def _virtual(self, path: Path) -> str:
        rel = path.relative_to(self.root).as_posix()
        return VIRTUAL_ROOT if rel == "." else f"{VIRTUAL_ROOT}/{rel}"

    # -- commands ------------------------------------------------------------

    def execute(self, args: Mapping[str, Any]) -> ToolResult:
        command = args.get("command")
        handler = {
            "view": self.view,
            "create": self.create,
            "str_replace": self.str_replace,
            "insert": self.insert,
            "delete": self.delete,
            "rename": self.rename,
        }.get(command if isinstance(command, str) else "")
        if handler is None:
            return ToolResult.error(f"Unknown memory command: {command!r}")
        try:
            return ToolResult(handler(args))
        except (ValueError, OSError) as exc:
            return ToolResult.error(str(exc))

    def view(self, args: Mapping[str, Any]) -> str:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._resolve(args.get("path"))
        if path.is_dir():
            lines = [f"Directory: {self._virtual(path)}"]
            for child in sorted(path.rglob("*")):
                if child.is_file() and not any(part.startswith(".") for part in child.relative_to(path).parts):
                    lines.append(f"- {self._virtual(child)} ({child.stat().st_size} bytes)")
            return "\n".join(lines) if len(lines) > 1 else lines[0] + "\n(empty)"
        if not path.is_file():
            raise ValueError(f"The path {args.get('path')} does not exist.")
        content = path.read_text(encoding="utf-8").splitlines()
        start, end = 1, len(content)
        view_range = args.get("view_range")
        if isinstance(view_range, list) and len(view_range) == 2:
            start = max(1, int(view_range[0]))
            end = len(content) if int(view_range[1]) == -1 else min(len(content), int(view_range[1]))
        return "\n".join(f"{number:6d}\t{content[number - 1]}" for number in range(start, end + 1))

    def create(self, args: Mapping[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        text = args.get("file_text")
        if not isinstance(text, str):
            raise ValueError("'file_text' is required.")
        if path == self.root or path.is_dir():
            raise ValueError("Cannot overwrite a directory.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return f"File created successfully at: {self._virtual(path)}"

    def str_replace(self, args: Mapping[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        old, new = args.get("old_str"), args.get("new_str", "")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError("'old_str' (non-empty) and 'new_str' strings are required.")
        if not path.is_file():
            raise ValueError(f"The path {args.get('path')} does not exist.")
        text = path.read_text(encoding="utf-8")
        count = text.count(old)
        if count == 0:
            raise ValueError(f"No replacement was performed: old_str did not appear verbatim in {args.get('path')}.")
        if count > 1:
            raise ValueError(f"No replacement was performed: old_str appears {count} times; make it unique.")
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        return "The memory file has been edited."

    def insert(self, args: Mapping[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        line, text = args.get("insert_line"), args.get("insert_text")
        if not isinstance(line, int) or not isinstance(text, str):
            raise ValueError("'insert_line' (int) and 'insert_text' (string) are required.")
        if not path.is_file():
            raise ValueError(f"The path {args.get('path')} does not exist.")
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line < 0 or line > len(lines):
            raise ValueError(f"insert_line must be between 0 and {len(lines)}.")
        if lines and not lines[-1].endswith("\n") and line == len(lines):
            lines[-1] += "\n"
        lines.insert(line, text if text.endswith("\n") else text + "\n")
        path.write_text("".join(lines), encoding="utf-8")
        return f"The file {args.get('path')} has been edited."

    def delete(self, args: Mapping[str, Any]) -> str:
        path = self._resolve(args.get("path"))
        if path == self.root:
            raise ValueError("Refusing to delete the memory root.")
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        else:
            raise ValueError(f"The path {args.get('path')} does not exist.")
        return f"Deleted {self._virtual(path)}"

    def rename(self, args: Mapping[str, Any]) -> str:
        source = self._resolve(args.get("old_path"))
        target = self._resolve(args.get("new_path"))
        if not source.exists():
            raise ValueError(f"The path {args.get('old_path')} does not exist.")
        if target.exists():
            raise ValueError(f"The destination {args.get('new_path')} already exists.")
        if source == self.root:
            raise ValueError("Refusing to rename the memory root.")
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        return f"Renamed {self._virtual(source)} to {self._virtual(target)}"
`;
}
