import { stripPrivateKeywords } from "../../../core/json-schema.js";
import type { JSONSchema, ToolSpec } from "../../../core/types.js";
import { SERVER_KINDS, type PyContext } from "../context.js";
import { pyLiteral, pyStr, pyText } from "../py.js";
import { docstring } from "./config.js";

/**
 * The input_schema sent to the API for a client tool (always an object schema), without decree-private keywords
 * (`x-allow-flags`, ...): the binding carries allowFlags instead.
 */
export function apiInputSchema(tool: ToolSpec): JSONSchema {
  if (SERVER_KINDS.has(tool.kind) || tool.kind === "memory") return {};
  const schema = stripPrivateKeywords(tool.inputSchema ?? {});
  if (schema.type === "object") return schema.properties ? schema : { ...schema, properties: {} };
  return { type: "object", properties: {}, ...schema, ...(schema.type ? {} : { type: "object" }) };
}

function binding(tool: ToolSpec): Record<string, unknown> {
  if (tool.kind === "http" && tool.http) return { ...tool.http };
  if (tool.kind === "shell" && tool.shell) {
    // Params whose values may start with "-" (schema "x-allow-flags": true).
    const props = tool.inputSchema?.properties ?? {};
    const allowFlags = Object.keys(props).filter((k) => (props[k] as Record<string, unknown> | undefined)?.["x-allow-flags"] === true);
    return allowFlags.length ? { ...tool.shell, allowFlags } : { ...tool.shell };
  }
  if (tool.fs) return { ...tool.fs };
  return {};
}

const b = (v: boolean) => (v ? "True" : "False");

function toolDef(tool: ToolSpec): string {
  const ind = "        ";
  return `    ToolDef(
        name=${pyStr(tool.name)},
        description=${pyText(tool.description, ind + "    ")},
        kind=${pyStr(tool.kind)},
        input_schema=${pyLiteral(apiInputSchema(tool), ind)},
        read_only=${b(tool.readOnly)},
        destructive=${b(tool.destructive)},
        requires_approval=${b(tool.requiresApproval)},
        binding=${pyLiteral(binding(tool), ind)},
        source=${pyStr(tool.source ?? "")},
    ),`;
}

export function toolsRegistryPy(ctx: PyContext): string {
  const { has } = ctx;
  const imports = [
    has.decisions ? "from .decisions import get_decisions" : "",
    has.fs ? "from .fs import list_files, read_file, search, write_file" : "",
    has.http ? "from .http import call_http" : "",
    has.memory ? "from .memory import MemoryStore" : "",
    has.shell ? "from .shell import run_shell" : "",
  ].filter(Boolean);

  const dispatch: string[] = [];
  if (has.http) dispatch.push(`    if tool.kind == "http":\n        return call_http(tool.binding, args)`);
  if (has.shell) dispatch.push(`    if tool.kind == "shell":\n        return run_shell(tool.binding, args, ctx.project_root)`);
  if (has.fs) {
    dispatch.push(`    if tool.kind == "read_file":\n        return read_file(tool.binding, args, ctx.project_root)`);
    dispatch.push(`    if tool.kind == "write_file":\n        return write_file(tool.binding, args, ctx.project_root)`);
    dispatch.push(`    if tool.kind == "list_files":\n        return list_files(tool.binding, args, ctx.project_root)`);
    dispatch.push(`    if tool.kind == "search":\n        return search(tool.binding, args, ctx.project_root)`);
  }
  if (has.decisions) dispatch.push(`    if tool.kind == "decisions":\n        return get_decisions(args, ctx.project_root)`);
  if (has.memory) {
    dispatch.push(`    if tool.kind == "memory":
        if ctx.memory is None:
            ctx.memory = MemoryStore(memory_dir())
        return ctx.memory.execute(args)`);
  }

  const configImports = ["APPROVAL_MODE", "SERVER_TOOL_MAX_USES", ...(has.memory ? ["memory_dir"] : [])];

  return String.raw`${docstring(ctx, "Tool registry: definitions (in spec order), API parameters, approval policy and dispatch.")}

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import ${configImports.join(", ")}
from .base import ToolResult, redact
${imports.join("\n")}

#: Anthropic server tools: executed by the API, declared by type.
SERVER_TOOL_TYPES: dict[str, str] = {
    "web_search": "web_search_20260209",
    "web_fetch": "web_fetch_20260209",
}
MEMORY_TOOL_TYPE = "memory_20250818"

DECLINED_MESSAGE = "The user declined this action. Ask them how to proceed."


@dataclass(frozen=True)
class ToolDef:
    """One tool from decree.json plus its execution binding."""

    name: str
    description: str
    kind: str
    input_schema: dict[str, Any]
    read_only: bool
    destructive: bool
    requires_approval: bool
    binding: dict[str, Any] = field(default_factory=dict)
    source: str = ""

    @property
    def is_server_tool(self) -> bool:
        return self.kind in SERVER_TOOL_TYPES

    @property
    def api_name(self) -> str:
        """The name the model uses (server tools and memory have fixed names)."""
        if self.is_server_tool:
            return self.kind
        if self.kind == "memory":
            return "memory"
        return self.name


TOOLS: tuple[ToolDef, ...] = (
${ctx.tools.map(toolDef).join("\n")}
)

TOOLS_BY_NAME: dict[str, ToolDef] = {tool.name: tool for tool in TOOLS}
#: Lookup by the name that appears in tool_use / server_tool_use blocks.
TOOLS_BY_API_NAME: dict[str, ToolDef] = {tool.api_name: tool for tool in TOOLS}


def to_api_param(tool: ToolDef) -> dict[str, Any]:
    """The entry for the request's tools list."""
    if tool.is_server_tool:
        return {"type": SERVER_TOOL_TYPES[tool.kind], "name": tool.kind, "max_uses": SERVER_TOOL_MAX_USES}
    if tool.kind == "memory":
        return {"type": MEMORY_TOOL_TYPE, "name": "memory"}
    return {"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}


def api_tool_params(names: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """Tool params in spec order (a stable order keeps the prompt-cache prefix stable)."""
    wanted = None if names is None else set(names)
    return [to_api_param(tool) for tool in TOOLS if wanted is None or tool.name in wanted]


def needs_approval(tool: ToolDef, mode: str = APPROVAL_MODE) -> bool:
    """Whether a human must confirm this tool call before it runs."""
    if mode == "never":
        return False
    if mode == "always":
        return not tool.read_only or tool.requires_approval
    return tool.requires_approval or tool.destructive


@dataclass
class ToolContext:
    """Per-run state shared by tool executions."""

    project_root: Path
    dry_run: bool = False${has.memory ? "\n    memory: MemoryStore | None = None" : ""}


_JSON_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list,),
    "null": (type(None),),
}


def _matches_type(value: Any, json_type: str) -> bool:
    if json_type in ("integer", "number") and isinstance(value, bool):
        return False
    if json_type == "integer" and isinstance(value, float):
        return value.is_integer()
    expected = _JSON_TYPES.get(json_type)
    return expected is None or isinstance(value, expected)


def validate_input(schema: Mapping[str, Any], args: Mapping[str, Any]) -> str | None:
    """A cheap top-level check of required keys, types and enums. Returns a problem or None."""
    missing = [key for key in schema.get("required") or () if args.get(key) is None]
    if missing:
        return "Missing required input: " + ", ".join(missing)
    properties = schema.get("properties") or {}
    for key, value in args.items():
        prop = properties.get(key)
        if not isinstance(prop, dict) or value is None:
            continue
        types = prop.get("type")
        types = [types] if isinstance(types, str) else list(types or [])
        if types and not any(_matches_type(value, t) for t in types):
            return f"Input {key!r} must be of type {' or '.join(types)}."
        enum = prop.get("enum")
        if isinstance(enum, list) and value not in enum:
            return f"Input {key!r} must be one of {json.dumps(enum)}."
    return None


def execute_tool(tool: ToolDef, args: Any, ctx: ToolContext) -> ToolResult:
    """Run a client tool. Never raises: failures come back as error results, redacted."""
    if not isinstance(args, dict):
        return ToolResult.error("Tool input must be a JSON object.")
    if tool.kind != "memory":
        problem = validate_input(tool.input_schema, args)
        if problem:
            return ToolResult.error(problem)
    if ctx.dry_run${has.decisions ? ' and tool.kind != "decisions"' : ""}:
        preview = json.dumps(args, ensure_ascii=False, sort_keys=True)
        return ToolResult(redact(f"[dry run] {tool.name} was not executed. Input: {preview}"))
    try:
        result = _dispatch(tool, args, ctx)
    except Exception as exc:  # a broken tool must not take the agent loop down
        result = ToolResult.error(f"{tool.name} failed: {type(exc).__name__}: {exc}")
    return ToolResult(redact(result.output), result.is_error)


def _dispatch(tool: ToolDef, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
${dispatch.join("\n")}${dispatch.length ? "\n" : ""}    if tool.is_server_tool:
        return ToolResult.error(f"{tool.name} runs on Anthropic's servers and cannot be executed locally.")
    return ToolResult.error(f"No executor for tool kind {tool.kind!r}.")
`;
}
