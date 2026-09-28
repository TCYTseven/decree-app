import type { Guardrails, HarnessSpec, ToolSpec } from "../../core/types.js";

/** Approval rule from docs/ARCHITECTURE.md ("Approval"). */
export function needsApproval(tool: ToolSpec, mode: Guardrails["approvalMode"]): boolean {
  if (mode === "never") return false;
  if (mode === "always") return !tool.readOnly || tool.requiresApproval;
  return tool.requiresApproval || tool.destructive;
}

/** Placeholder names (`{{name}}`) used by a shell command template, in order of first appearance. */
export function shellPlaceholders(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Human-readable form of a shell template: `npm test -- {{pattern}}` -> `npm test -- <pattern>`. */
export function displayShellCommand(command: string): string {
  return command.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, "<$1>");
}

/**
 * The fixed part of a shell template, i.e. everything before the first
 * placeholder, with a trailing `--` separator and whitespace removed.
 * `npm test -- {{pattern}}` -> `npm test`.
 */
export function shellCommandPrefix(command: string): string {
  const idx = command.search(/\{\{/);
  let prefix = (idx === -1 ? command : command.slice(0, idx)).trim();
  prefix = prefix.replace(/(\s+--)+$/, "").trim();
  return prefix;
}

/** Every env var name a tool reads (base URL + auth), in tool order, de-duplicated. */
export function toolEnvRefs(tools: ToolSpec[]): string[] {
  const out: string[] = [];
  const add = (n?: string) => {
    if (n && !out.includes(n)) out.push(n);
  };
  for (const t of tools) {
    if (t.kind !== "http" || !t.http) continue;
    add(t.http.baseUrlEnv);
    if (t.http.auth && t.http.auth.type !== "none") add(t.http.auth.env);
  }
  return out;
}

/** Default value for an env var: from spec.env, else from an http tool's defaultBaseUrl. */
export function envDefault(spec: HarnessSpec, name: string): string | undefined {
  const e = spec.env.find((v) => v.name === name);
  if (e?.default !== undefined) return e.default;
  for (const t of spec.tools) if (t.http?.baseUrlEnv === name && t.http.defaultBaseUrl) return t.http.defaultBaseUrl;
  return undefined;
}

/** Tool names in spec order that are http tools (served by the generated MCP server). */
export function httpTools(spec: HarnessSpec): ToolSpec[] {
  return spec.tools.filter((t) => t.kind === "http" && t.http);
}

/** Short yes/no rendering. */
export function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}

/** A one-line description of a tool's binding (for tables and docs). */
export function describeBinding(tool: ToolSpec): string {
  switch (tool.kind) {
    case "http":
      return tool.http ? `${tool.http.method} \${${tool.http.baseUrlEnv}}${tool.http.path}` : "http (unbound)";
    case "shell":
      return tool.shell ? `${displayShellCommand(tool.shell.command)}${tool.shell.cwd && tool.shell.cwd !== "." ? ` (cwd: ${tool.shell.cwd})` : ""}` : "shell (unbound)";
    case "read_file":
    case "write_file":
    case "list_files":
    case "search":
      return `${tool.kind} under ${tool.fs?.root ?? "."}`;
    case "web_search":
    case "web_fetch":
      return `Anthropic server tool (${tool.kind})`;
    case "memory":
      return "Anthropic memory tool";
    case "decisions":
      return "decisions in decree.json, scoped to the paths passed";
    default:
      return String(tool.kind);
  }
}
