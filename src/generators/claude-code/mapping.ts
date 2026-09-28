import type { GenerateOptions, HarnessSpec, ToolSpec } from "../../core/types.js";
import { needsApproval, shellCommandPrefix } from "../common/spec-utils.js";

/** Read-only fallback when a spec agent maps to zero Claude Code tools (omitting `tools` would inherit ALL tools). */
export const FALLBACK_TOOLS = ["Read", "Grep", "Glob"];

/** Name of the MCP server entry in `.mcp.json`; Claude Code allows letters, digits, `-` and `_`. */
export function mcpServerName(spec: HarnessSpec): string {
  const s = spec.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "decree-agent";
}

/** Script that answers get_decisions in Claude Code without the MCP server (node, no dependencies). */
export const DECISIONS_SCRIPT = ".claude/skills/decisions/get-decisions.mjs";
/** The one Bash command the decisions script needs: narrow enough to allow. */
export const DECISIONS_BASH_RULE = `Bash(node ${DECISIONS_SCRIPT}:*)`;

export interface MappingOptions {
  /** get_decisions is served by the generated MCP server (wired in .mcp.json) rather than only by the script. */
  decisionsViaMcp?: boolean;
}

/**
 * How Claude Code reaches get_decisions. When the MCP server is generated alongside (or already wired for API
 * tools), it is the MCP tool `mcp__<server>__get_decisions`; otherwise the `decisions` skill's script, run with Bash.
 * The skill and script are generated either way, as the fallback when the MCP server is not running.
 */
export function decisionsViaMcp(spec: HarnessSpec, opts: Pick<GenerateOptions, "targets">): boolean {
  if (!spec.tools.some((t) => t.kind === "decisions")) return false;
  return opts.targets ? opts.targets.includes("mcp") : spec.tools.some((t) => t.kind === "http" && t.http);
}

/** Claude Code tool name for an MCP tool served by the generated MCP server. */
export function mcpToolName(spec: HarnessSpec, tool: ToolSpec): string {
  return `mcp__${mcpServerName(spec)}__${tool.name}`;
}

/** Map one harness tool to the Claude Code tools that provide the same capability. */
export function claudeToolsFor(spec: HarnessSpec, tool: ToolSpec, o: MappingOptions = {}): string[] {
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
    case "decisions":
      return o.decisionsViaMcp ? [mcpToolName(spec, tool)] : ["Bash"];
    default:
      return [];
  }
}

/** Permission rules that let Claude Code use a read-only harness tool without asking. */
export function allowRulesFor(spec: HarnessSpec, tool: ToolSpec, o: MappingOptions = {}): string[] {
  if (tool.kind === "shell") return bashRules(tool);
  if (tool.kind === "decisions") return o.decisionsViaMcp ? [mcpToolName(spec, tool), DECISIONS_BASH_RULE] : [DECISIONS_BASH_RULE];
  return claudeToolsFor(spec, tool, o);
}

/** Map a list of harness tool names to a de-duplicated, spec-ordered list of Claude Code tools. */
export function claudeToolsForNames(spec: HarnessSpec, names: string[], o: MappingOptions = {}): string[] {
  const out: string[] = [];
  for (const t of spec.tools) {
    if (!names.includes(t.name)) continue;
    for (const c of claudeToolsFor(spec, t, o)) if (!out.includes(c)) out.push(c);
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

/**
 * Generic runners: a `Bash(<runner>:*)` rule would allow any script / any code
 * (`npm run:*` runs every script, `sh -c:*` runs anything).
 */
const GENERIC_RUNNERS = new Set([
  "sh -c", "bash -c", "zsh -c", "dash -c",
  "npm run", "npm exec", "npm run-script", "pnpm", "pnpm run", "pnpm exec", "pnpm dlx", "yarn", "yarn run", "yarn dlx", "npx", "bunx", "bun run", "bun x",
  "python -c", "python3 -c", "python -m", "python3 -m", "node -e", "node -p", "node --eval", "deno eval", "ruby -e", "perl -e",
  "make", "uv run", "uvx", "poetry run", "pipenv run", "cargo run", "go run", "just", "task",
]);

/**
 * True when `Bash(<prefix>:*)` would be much broader than the tool: a prefix of fewer
 * than 2 words (`pytest:*`, `make:*`) or a generic runner with nothing after it.
 */
export function isBroadShellPrefix(prefix: string): boolean {
  const norm = prefix.replace(/\s+/g, " ").trim();
  return norm.split(" ").filter(Boolean).length < 2 || GENERIC_RUNNERS.has(norm);
}

/**
 * `Bash(<prefix>:*)` permission rules for a shell tool that are narrow enough to
 * pre-approve (allow lists, skill/command `allowed-tools`). Broad prefixes are left
 * out: see `broadBashRules`.
 */
export function bashRules(tool: ToolSpec): string[] {
  if (!tool.shell) return [];
  return shellRulePrefixes(tool.shell.command)
    .filter((p) => !isBroadShellPrefix(p))
    .map((p) => `Bash(${p}:*)`);
}

/** Rules whose prefix is too broad to allow (`Bash(npm run:*)`, `Bash(sh -c:*)`): these go to `ask`. */
export function broadBashRules(tool: ToolSpec): string[] {
  if (!tool.shell) return [];
  return shellRulePrefixes(tool.shell.command)
    .filter(isBroadShellPrefix)
    .map((p) => `Bash(${p}:*)`);
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
 *  - a shell rule whose prefix is broader than the tool (fewer than 2 words, or a
 *    generic runner such as `npm run` / `sh -c`) -> ask
 *  - everything else -> allow
 *  - guardrails.blockedCommands -> deny (prefix and anywhere-in-command forms)
 *  - secrets (.env files) -> deny Read
 * Deny beats ask beats allow in Claude Code, so overlaps resolve safely.
 */
export function derivePermissions(spec: HarnessSpec, o: MappingOptions = {}): Permissions {
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
        // A broad prefix would allow far more than this tool: always ask.
        push(p.ask, ...broadBashRules(t));
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
      case "decisions":
        push(list, ...allowRulesFor(spec, t, o));
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
