import path from "node:path";
import type { GenerateOptions, HarnessSpec, ToolKind, ToolSpec } from "../../core/types.js";

/** Tool kinds a stdio MCP server can execute locally. */
export const MCP_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  "http",
  "shell",
  "read_file",
  "write_file",
  "list_files",
  "search",
]);

export const ROOT_ENV = "DECREE_PROJECT_ROOT";
export const READ_ONLY_ENV = "DECREE_MCP_READ_ONLY";

export interface McpEnvVar {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default?: string;
}

export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  text: string;
  tools: string[];
}

export interface McpModel {
  spec: HarnessSpec;
  serverName: string;
  packageName: string;
  version: string;
  decreeVersion: string;
  tools: ToolSpec[];
  skipped: ToolSpec[];
  prompts: McpPrompt[];
  env: McpEnvVar[];
  /** Relative path from the generated `src/` (or `dist/`) dir to the project root, or null if unknown. */
  rootFromSrc: string | null;
  /** outDir relative to the project root (POSIX), when known. */
  outDirRel: string | null;
}

export function needsApproval(spec: HarnessSpec, tool: ToolSpec): boolean {
  switch (spec.guardrails.approvalMode) {
    case "never":
      return false;
    case "always":
      return !tool.readOnly || tool.requiresApproval;
    default:
      return tool.requiresApproval || tool.destructive;
  }
}

export function isIdempotent(tool: ToolSpec): boolean {
  if (tool.readOnly) return true;
  if (tool.kind === "write_file") return true;
  if (tool.kind === "http" && tool.http) return ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(tool.http.method);
  return false;
}

/** Human title from a snake/kebab tool name: "list_orders" -> "List orders". */
export function titleFromName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** Description sent to MCP clients: the spec description plus guardrail notes. */
export function toolDescription(spec: HarnessSpec, tool: ToolSpec): string {
  let d = tool.description.trim();
  if (tool.destructive) {
    d +=
      "\n\nDESTRUCTIVE: this tool changes or deletes data and may be irreversible. " +
      "Confirm the exact arguments with the user before calling it.";
  } else if (needsApproval(spec, tool)) {
    d += "\n\nRequires approval: confirm with the user before calling this tool.";
  }
  return d;
}

function outDirRelative(outDir: string): string | null {
  if (!outDir || path.isAbsolute(outDir) || /^[a-zA-Z]:[\\/]/.test(outDir)) return null;
  const norm = path.posix.normalize(outDir.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (norm === "" || norm === ".") return ".";
  if (norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

export function buildModel(spec: HarnessSpec, opts: GenerateOptions): McpModel {
  const tools = spec.tools.filter((t) => MCP_KINDS.has(t.kind));
  const skipped = spec.tools.filter((t) => !MCP_KINDS.has(t.kind));
  const exposed = new Set(tools.map((t) => t.name));

  const outDirRel = outDirRelative(opts.outDir);
  // Generated server lives at <outDir>/mcp-server/src/server.ts.
  let rootFromSrc: string | null = null;
  if (outDirRel !== null) {
    const depth = outDirRel === "." ? 0 : outDirRel.split("/").length;
    rootFromSrc = ["..", "..", ...Array.from({ length: depth }, () => "..")].join("/");
  }

  // Prompts: main agent + one per subagent, names unique.
  const used = new Set<string>();
  const unique = (base: string): string => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    used.add(n);
    return n;
  };
  const exposedList = tools.map((t) => t.name);
  const prompts: McpPrompt[] = [
    {
      name: unique(spec.name.endsWith("-agent") ? spec.name : `${spec.name}-agent`),
      title: spec.displayName,
      description: `System prompt for ${spec.displayName}. ${spec.description}`.trim(),
      text: spec.systemPrompt,
      tools: exposedList,
    },
    ...spec.subagents.map((s) => ({
      name: unique(s.name),
      title: titleFromName(s.name),
      description: `Subagent: ${s.description}`,
      text: s.systemPrompt,
      tools: s.tools.filter((n) => exposed.has(n)),
    })),
  ];

  // Env vars the server reads: spec env (minus the Anthropic key, unused here) + tool bindings.
  const env: McpEnvVar[] = [];
  const seen = new Set<string>();
  const add = (v: McpEnvVar) => {
    if (seen.has(v.name)) return;
    seen.add(v.name);
    env.push(v);
  };
  const specEnv = new Map(spec.env.map((e) => [e.name, e]));
  for (const e of spec.env) {
    if (e.name === "ANTHROPIC_API_KEY") continue;
    add({ ...e });
  }
  for (const t of tools) {
    if (!t.http) continue;
    const h = t.http;
    if (!specEnv.has(h.baseUrlEnv)) {
      add({
        name: h.baseUrlEnv,
        description: "Base URL of the API",
        required: h.defaultBaseUrl === undefined,
        secret: false,
        ...(h.defaultBaseUrl !== undefined ? { default: h.defaultBaseUrl } : {}),
      });
    }
    if (h.auth?.env && h.auth.type !== "none" && !specEnv.has(h.auth.env)) {
      add({ name: h.auth.env, description: "API credential", required: true, secret: true });
    }
  }
  add({
    name: ROOT_ENV,
    description:
      rootFromSrc !== null
        ? "Absolute path of the project the tools operate on (default: the project this server was generated into)"
        : "Absolute path of the project the tools operate on (default: the current working directory)",
    required: false,
    secret: false,
  });
  add({
    name: READ_ONLY_ENV,
    description: "Set to 1 to register only read-only tools",
    required: false,
    secret: false,
  });

  return {
    spec,
    serverName: spec.name,
    packageName: `${spec.name}-mcp`,
    version: "0.1.0",
    decreeVersion: opts.decreeVersion,
    tools,
    skipped,
    prompts,
    env,
    rootFromSrc,
    outDirRel,
  };
}
