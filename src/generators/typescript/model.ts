import type { Effort, GenerateOptions, HarnessSpec, ToolKind, ToolSpec } from "../../core/types.js";
import { sanitizeToolName, uniqueName } from "./render.js";

/** A spec tool as it appears in the generated project (name sanitized and unique). */
export interface TsTool {
  name: string;
  spec: ToolSpec;
}

export interface TsSubagent {
  name: string; // original kebab-case name, for display
  toolName: string; // delegate_to_<name>
  description: string;
  systemPrompt: string;
  tools: string[]; // generated tool names
  model: string;
  effort: Effort;
}

/** Everything the templates need, derived once from the spec. */
export interface TsModel {
  spec: HarnessSpec;
  opts: GenerateOptions;
  tools: TsTool[];
  subagents: TsSubagent[];
  kinds: Set<ToolKind>;
  /** spec.env, guaranteed to include ANTHROPIC_API_KEY. */
  env: HarnessSpec["env"];
  /** How many directories above the generated package the project root sits. */
  projectRootDepth: number;
}

/** Anthropic-defined tools have fixed names. */
const FIXED_NAMES: Partial<Record<ToolKind, string>> = {
  web_search: "web_search",
  web_fetch: "web_fetch",
  memory: "memory",
};

const FS_KINDS: ToolKind[] = ["read_file", "write_file", "list_files", "search"];

export function isFsKind(kind: ToolKind): boolean {
  return FS_KINDS.includes(kind);
}

export function buildModel(spec: HarnessSpec, opts: GenerateOptions): TsModel {
  const taken = new Set<string>();
  const renamed = new Map<string, string>(); // spec name -> generated name
  const tools: TsTool[] = [];

  for (const tool of spec.tools) {
    const fixed = FIXED_NAMES[tool.kind];
    let name: string;
    if (fixed) {
      if (taken.has(fixed)) {
        if (!renamed.has(tool.name)) renamed.set(tool.name, fixed); // a second web_search etc. collapses into the first
        continue;
      }
      name = fixed;
      taken.add(fixed);
    } else {
      name = uniqueName(sanitizeToolName(tool.name), taken);
    }
    if (!renamed.has(tool.name)) renamed.set(tool.name, name); // references resolve to the first tool of that name
    tools.push({ name, spec: tool });
  }

  if (spec.context.memory && !taken.has("memory")) {
    taken.add("memory");
    tools.push({
      name: "memory",
      spec: {
        name: "memory",
        description: "Persistent notes across sessions.",
        kind: "memory",
        inputSchema: {},
        readOnly: false,
        destructive: false,
        requiresApproval: false,
        source: "builtin",
      },
    });
  }

  const subagents: TsSubagent[] = spec.subagents.map((sub) => ({
    name: sub.name,
    toolName: uniqueName(sanitizeToolName(`delegate_to_${sub.name.replace(/-/g, "_")}`), taken),
    description: sub.description,
    systemPrompt: sub.systemPrompt,
    tools: [...new Set(sub.tools.map((t) => renamed.get(t)).filter((t): t is string => t !== undefined))],
    model: sub.model ?? spec.model.subagentId,
    effort: sub.effort ?? "medium",
  }));

  return {
    spec,
    opts,
    tools,
    subagents,
    kinds: new Set(tools.map((t) => t.spec.kind)),
    env: spec.env.some((e) => e.name === "ANTHROPIC_API_KEY")
      ? spec.env
      : [{ name: "ANTHROPIC_API_KEY", description: "Anthropic API key", required: true, secret: true }, ...spec.env],
    projectRootDepth: projectRootDepth(opts.outDir),
  };
}

/**
 * The generated package lives at `<outDir>/typescript`. When outDir is a plain
 * relative path (the default `agent`), the project root is one level above
 * outDir; otherwise assume the default layout (two levels up).
 */
function projectRootDepth(outDir: string): number {
  const parts = outDir.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  const relative = !outDir.startsWith("/") && !/^[A-Za-z]:/.test(outDir) && !parts.includes("..");
  return relative && parts.length > 0 ? parts.length + 1 : 2;
}
