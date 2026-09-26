import type { JSONSchema, ToolSpec } from "../../../core/types.js";
import { stripPrivateKeywords } from "../../../core/json-schema.js";
import { isFsKind, type TsModel, type TsTool } from "../model.js";
import { indent, oneLine, tsLiteral } from "../render.js";

/** Helper module (under src/tools/) and function that implement each client-side kind. */
const RUNNERS = {
  http: { module: "http", fn: "callHttp" },
  shell: { module: "shell", fn: "runShell" },
  read_file: { module: "fs", fn: "readFile" },
  write_file: { module: "fs", fn: "writeFile" },
  list_files: { module: "fs", fn: "listFiles" },
  search: { module: "fs", fn: "searchFiles" },
  memory: { module: "memory", fn: "runMemory" },
} as const;

/** Anthropic server tools, declared by type (no local executor). */
const SERVER_TOOLS = {
  web_search: { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  web_fetch: { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
} as const;

export function toolsIndexTs(m: TsModel): string {
  const imports = new Map<string, Set<string>>();
  for (const t of m.tools) {
    const runner = t.spec.kind in RUNNERS ? RUNNERS[t.spec.kind as keyof typeof RUNNERS] : undefined;
    if (runner && hasBinding(t.spec)) {
      const fns = imports.get(runner.module) ?? new Set<string>();
      fns.add(runner.fn);
      imports.set(runner.module, fns);
    }
  }
  const importLines = [...imports.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mod, fns]) => `import { ${[...fns].sort().join(", ")} } from "./${mod}.js";`);

  const entries = m.tools.map((t) => indent(toolEntry(t), 2)).join("\n");

  return `/**
 * Tool registry, generated from decree.json.
 *
 * Each entry pairs the definition sent to Claude with its local executor and
 * safety flags. The order is part of the cached prompt prefix: append new
 * tools at the end rather than reordering.
 */
import type { ToolEntry } from "../types.js";
${importLines.join("\n")}

export const TOOLS: ToolEntry[] = [
${entries}
];
`;
}

function hasBinding(spec: ToolSpec): boolean {
  if (spec.kind === "http") return spec.http !== undefined;
  if (spec.kind === "shell") return spec.shell !== undefined;
  return true;
}

function toolEntry(t: TsTool): string {
  const { spec } = t;
  const flags = `readOnly: ${spec.readOnly},\ndestructive: ${spec.destructive},\nrequiresApproval: ${spec.requiresApproval},`;
  const comment = `// ${oneLine(`${t.name}${spec.source ? ` (${spec.source})` : ""}`).replace(/\*\//g, "* /")}`;

  if (spec.kind === "web_search" || spec.kind === "web_fetch") {
    return `${comment}\n{\n  definition: ${tsLiteral(SERVER_TOOLS[spec.kind], 1)},\n${indent(flags, 2)}\n},`;
  }
  if (spec.kind === "memory") {
    const definition = { type: "memory_20250818", name: "memory" };
    return `${comment}\n{\n  definition: ${tsLiteral(definition, 1)},\n${indent(flags, 2)}\n  run: runMemory,\n},`;
  }

  const definition = {
    name: t.name,
    description: spec.description,
    input_schema: objectSchema(spec.inputSchema),
    // Stream tool input as it is generated; the loop validates it before running.
    eager_input_streaming: true,
  };
  return `${comment}\n{\n  definition: ${tsLiteral(definition, 1)},\n${indent(flags, 2)}\n  run: ${runExpression(spec)},\n},`;
}

/**
 * Tool input schemas must be objects; tolerate specs that omit `type`. decree-private keywords (`x-allow-flags`,
 * ...) are stripped: the API never sees them (the shell binding carries allowFlags instead).
 */
function objectSchema(schema: JSONSchema): JSONSchema {
  const { type: _type, ...rest } = stripPrivateKeywords(schema ?? {});
  return { type: "object", properties: {}, ...rest };
}

function runExpression(spec: ToolSpec): string {
  const kind = spec.kind as keyof typeof RUNNERS;
  const runner = RUNNERS[kind];
  switch (spec.kind) {
    case "http":
      if (!spec.http) return missingBinding("http");
      return `(input) =>\n    ${runner.fn}(input, ${tsLiteral(spec.http, 2)})`;
    case "shell":
      if (!spec.shell) return missingBinding("shell");
      return `(input) =>\n    ${runner.fn}(input, ${tsLiteral(shellBinding(spec), 2)})`;
    default: {
      const fs = spec.fs ?? { root: "." };
      const binding = isFsKind(spec.kind) && spec.kind !== "read_file" ? { root: fs.root } : fs;
      return `(input) => ${runner.fn}(input, ${tsLiteral(binding, 2)})`;
    }
  }
}

/** The shell binding plus the params whose schema sets `"x-allow-flags": true`. */
export function flagParams(spec: ToolSpec): string[] {
  const props = spec.inputSchema?.properties ?? {};
  return Object.keys(props).filter((k) => (props[k] as Record<string, unknown> | undefined)?.["x-allow-flags"] === true);
}

function shellBinding(spec: ToolSpec): Record<string, unknown> {
  const allowFlags = flagParams(spec);
  return allowFlags.length ? { ...spec.shell, allowFlags } : { ...spec.shell };
}

function missingBinding(kind: string): string {
  return `async () => ({ output: "This tool has no ${kind} binding in decree.json; add one and regenerate.", isError: true })`;
}
