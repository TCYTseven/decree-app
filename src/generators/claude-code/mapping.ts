import type { HarnessSpec, ToolSpec } from "../../core/types.js";
import { needsApproval, shellCommandPrefix } from "../common/spec-utils.js";

/** Read-only fallback when a spec agent maps to zero Claude Code tools (omitting `tools` would inherit ALL tools). */
export const FALLBACK_TOOLS = ["Read", "Grep", "Glob"];

/** Name of the MCP server entry in `.mcp.json`; Claude Code allows letters, digits, `-` and `_`. */
export function mcpServerName(spec: HarnessSpec): string {
  const s = spec.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "decree-agent";
}

/** Claude Code tool name for an MCP tool served by the generated MCP server. */
export function mcpToolName(spec: HarnessSpec, tool: ToolSpec): string {
  return `mcp__${mcpServerName(spec)}__${tool.name}`;
}

/** Map one harness tool to the Claude Code tools that provide the same capability. */
export function claudeToolsFor(spec: HarnessSpec, tool: ToolSpec): string[] {
  switch (tool.kind) {
    case "read_file":
      return ["Read"];
    case "list_files":
      return ["Glob"];
    case "search":
      return ["Grep"];
    case "write_file":
      return ["Write", "Edit"];
    case "shell":
      return ["Bash"];
    case "web_search":
      return ["WebSearch"];
    case "web_fetch":
      return ["WebFetch"];
    case "memory":
      // Claude Code has no memory tool; agents get `memory: project` frontmatter instead.
      return [];
    case "http":
      return [mcpToolName(spec, tool)];
    default:
      return [];
  }
}

/** Map a list of harness tool names to a de-duplicated, spec-ordered list of Claude Code tools. */
export function claudeToolsForNames(spec: HarnessSpec, names: string[]): string[] {
  const out: string[] = [];
  for (const t of spec.tools) {
    if (!names.includes(t.name)) continue;
    for (const c of claudeToolsFor(spec, t)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Claude Code model alias for a model id. */
export function claudeModelAlias(modelId: string | undefined): "opus" | "sonnet" | "haiku" | "fable" | "inherit" {
  const id = (modelId ?? "").toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "fable";
  return "inherit";
}

/**
 * Split the fixed prefix of a shell template into its sub-commands
 * (`a && b | c` -> [a, b, c]) so each gets its own permission rule, the way
 * Claude Code matches compound commands.
 */
export function shellRulePrefixes(command: string): string[] {
  const prefix = shellCommandPrefix(command);
  return prefix
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/(\s+--)+$/, "").trim())
    .filter((p) => p.length > 0 && !/[()]/.test(p));
}

/** `Bash(<prefix>:*)` permission rules for a shell tool. */
export function bashRules(tool: ToolSpec): string[] {
  if (!tool.shell) return [];
  return shellRulePrefixes(tool.shell.command).map((p) => `Bash(${p}:*)`);
}

function fsScoped(tool: ToolSpec, name: string): string {
  const root = (tool.fs?.root ?? ".").replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (!root || root.includes("..") || /[()*]/.test(root)) return name;
  return `${name}(./${root}/**)`;
}

export interface Permissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

function push(list: string[], ...items: string[]) {
  for (const i of items) if (!list.includes(i)) list.push(i);
}

/**
 * Derive Claude Code permission rules from the harness:
 *  - a tool that needs approval (per guardrails.approvalMode) or is destructive -> ask
 *  - everything else -> allow
 *  - guardrails.blockedCommands -> deny (prefix and anywhere-in-command forms)
 *  - secrets (.env files) -> deny Read
 * Deny beats ask beats allow in Claude Code, so overlaps resolve safely.
 */
export function derivePermissions(spec: HarnessSpec): Permissions {
  const p: Permissions = { allow: [], ask: [], deny: [] };
  for (const t of spec.tools) {
    const ask = needsApproval(t, spec.guardrails.approvalMode) || t.destructive;
    const list = ask ? p.ask : p.allow;
    switch (t.kind) {
      case "read_file":
        push(list, fsScoped(t, "Read"));
        break;
      case "list_files":
        push(list, fsScoped(t, "Glob"));
        break;
      case "search":
        push(list, fsScoped(t, "Grep"));
        break;
      case "write_file":
        push(list, fsScoped(t, "Write"), fsScoped(t, "Edit"));
        break;
      case "shell":
        push(list, ...bashRules(t));
        break;
      case "web_search":
        push(list, "WebSearch");
        break;
      case "web_fetch":
        push(list, "WebFetch");
        break;
      case "http":
        push(list, mcpToolName(spec, t));
        break;
      default:
        break;
    }
  }
  for (const cmd of spec.guardrails.blockedCommands) {
    const c = cmd.replace(/\s+/g, " ").trim();
    if (!c || /[()]/.test(c)) continue;
    push(p.deny, `Bash(${c}:*)`, `Bash(*${c}*)`);
  }
  push(p.deny, "Read(./.env)", "Read(./.env.*)");
  // An allow rule would be shadowed anyway; drop it so the file reads clearly.
  p.allow = p.allow.filter((r) => !p.ask.includes(r) && !p.deny.includes(r));
  return p;
}
