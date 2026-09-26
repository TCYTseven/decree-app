import type { GenerateOptions, HarnessSpec, SubagentSpec, ToolSpec } from "../../core/types.js";
import { envPrefix, pythonPackageName, scriptName } from "./py.js";

/** Everything the Python templates need, derived once from the spec. */
export interface PyContext {
  spec: HarnessSpec;
  opts: GenerateOptions;
  /** Python package (import) name, e.g. `acme_ops_agent`. */
  pkg: string;
  /** Distribution / console-script name, e.g. `acme-ops-agent`. */
  script: string;
  /** Prefix for the harness's own env vars, e.g. `ACME_OPS_AGENT`. */
  envPrefix: string;
  /** Tools in spec order (plus a builtin memory tool when `context.memory` asks for one). */
  tools: ToolSpec[];
  subagents: PySubagent[];
  has: {
    http: boolean;
    shell: boolean;
    fs: boolean;
    memory: boolean;
    subagents: boolean;
    serverTools: boolean;
    evals: boolean;
  };
}

export interface PySubagent extends SubagentSpec {
  /** Client tool name on the main agent: `delegate_to_<name>`. */
  toolName: string;
  /** Subagent tools that exist in the spec (unknown names are dropped). */
  resolvedTools: string[];
}

export const FS_KINDS = new Set(["read_file", "write_file", "list_files", "search"]);
export const SERVER_KINDS = new Set(["web_search", "web_fetch"]);

export const BUILTIN_MEMORY_TOOL: ToolSpec = {
  name: "memory",
  description: "Persistent notes across sessions.",
  kind: "memory",
  inputSchema: {},
  readOnly: false,
  destructive: false,
  requiresApproval: false,
  source: "builtin",
};

export function delegateToolName(subagentName: string): string {
  return `delegate_to_${subagentName.replace(/-/g, "_")}`;
}

export function buildContext(spec: HarnessSpec, opts: GenerateOptions): PyContext {
  const tools = [...spec.tools];
  if (spec.context.memory && !tools.some((t) => t.kind === "memory")) tools.push(BUILTIN_MEMORY_TOOL);
  const names = new Set(tools.map((t) => t.name));
  const subagents: PySubagent[] = spec.subagents.map((s) => ({
    ...s,
    toolName: delegateToolName(s.name),
    resolvedTools: s.tools.filter((n) => names.has(n)),
  }));
  const pkg = pythonPackageName(spec.name);
  const kinds = new Set(tools.map((t) => t.kind));
  return {
    spec,
    opts,
    pkg,
    script: scriptName(spec.name),
    envPrefix: envPrefix(pkg),
    tools,
    subagents,
    has: {
      http: kinds.has("http"),
      shell: kinds.has("shell"),
      fs: [...kinds].some((k) => FS_KINDS.has(k)),
      memory: kinds.has("memory"),
      subagents: subagents.length > 0,
      serverTools: [...kinds].some((k) => SERVER_KINDS.has(k)),
      evals: spec.evals.length > 0,
    },
  };
}
