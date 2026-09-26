import { z } from "zod";
import type { EvalCase, HarnessSpec, JSONSchema, SubagentSpec, Target, ToolKind, ToolSpec } from "./types.js";
import { DECREE_VERSION, DEFAULT_MODEL, DEFAULT_SUBAGENT_MODEL } from "../version.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BLOCKED_COMMANDS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "rm -rf .",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "git clean -fd",
  "DROP DATABASE",
  "DROP TABLE",
  "TRUNCATE TABLE",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "chmod -R 777",
  "shutdown",
  "reboot",
  "npm publish",
];

export const DEFAULT_GUARDRAILS: HarnessSpec["guardrails"] = {
  maxTurns: 40,
  maxOutputTokensPerTurn: 32000,
  maxCostUsd: 10,
  blockedCommands: DEFAULT_BLOCKED_COMMANDS,
  allowedPaths: ["."],
  redactEnv: [],
  approvalMode: "destructive",
};

export const DEFAULT_CONTEXT: HarnessSpec["context"] = {
  caching: true,
  compaction: true,
  contextEditing: false,
  memory: false,
};

export const DEFAULT_TARGETS: Target[] = ["typescript", "claude-code"];

const SERVER_KINDS = new Set<ToolKind>(["web_search", "web_fetch", "memory"]);
const FS_KINDS = new Set<ToolKind>(["read_file", "write_file", "list_files", "search"]);
const READ_ONLY_KINDS = new Set<ToolKind>(["read_file", "list_files", "search", "web_search", "web_fetch"]);
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default input schemas for fs kinds when the spec leaves them empty (matches runtime semantics). */
const FS_DEFAULT_SCHEMAS: Record<string, JSONSchema> = {
  read_file: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the root" } },
    required: ["path"],
  },
  write_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the root" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  list_files: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'" } },
    required: ["pattern"],
  },
  search: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regular expression" },
      glob: { type: "string", description: "Optional glob to restrict files" },
    },
    required: ["query"],
  },
};

// ---------------------------------------------------------------------------
// Zod schema (structure + defaults; cross-field normalization happens below)
// ---------------------------------------------------------------------------

const effortZ = z.enum(["low", "medium", "high", "xhigh", "max"]);
const toolKindZ = z.enum(["http", "shell", "read_file", "write_file", "list_files", "search", "web_search", "web_fetch", "memory"]);
const targetZ = z.enum(["typescript", "python", "claude-code", "mcp"]);
const jsonSchemaZ = z.record(z.string(), z.unknown()).describe("JSON Schema (type: object) for the tool input");

const httpZ = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  baseUrlEnv: z.string().min(1).optional().describe("Env var holding the base URL; defaults to <NAME>_BASE_URL"),
  defaultBaseUrl: z.string().optional(),
  path: z.string().min(1).describe("Path template, e.g. /users/{id}"),
  queryParams: z.array(z.string()).optional(),
  headerParams: z.array(z.string()).optional(),
  bodyParam: z.string().optional(),
  auth: z
    .object({
      type: z.enum(["bearer", "header", "none"]),
      env: z.string().optional(),
      header: z.string().optional(),
    })
    .optional(),
});

const shellZ = z.object({
  command: z.string().min(1).describe("Command template; {{param}} placeholders are shell-escaped"),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const fsZ = z.object({
  root: z.string().min(1).default("."),
  maxBytes: z.number().int().positive().optional(),
});

const toolZ = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  kind: toolKindZ,
  inputSchema: jsonSchemaZ.optional(),
  http: httpZ.optional(),
  shell: shellZ.optional(),
  fs: fsZ.optional(),
  readOnly: z.boolean().optional(),
  destructive: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  source: z.string().optional(),
});

const subagentZ = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  effort: effortZ.optional(),
});

const evalZ = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expect: z
    .object({
      toolsCalled: z.array(z.string()).optional(),
      toolsNotCalled: z.array(z.string()).optional(),
      contains: z.array(z.string()).optional(),
      notContains: z.array(z.string()).optional(),
      rubric: z.string().optional(),
    })
    .default({}),
  tags: z.array(z.string()).optional(),
});

const envZ = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  default: z.string().optional(),
});

export const HarnessSpecSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    name: z.string().min(1).describe("kebab-case slug"),
    displayName: z.string().optional(),
    description: z.string().default(""),
    goal: z.string().default(""),
    model: z
      .object({
        id: z.string().min(1).default(DEFAULT_MODEL),
        effort: effortZ.default("high"),
        subagentId: z.string().min(1).default(DEFAULT_SUBAGENT_MODEL),
        thinking: z.enum(["adaptive", "off"]).default("adaptive"),
      })
      .default({ id: DEFAULT_MODEL, effort: "high", subagentId: DEFAULT_SUBAGENT_MODEL, thinking: "adaptive" }),
    systemPrompt: z.string().min(1),
    tools: z.array(toolZ).default([]),
    subagents: z.array(subagentZ).default([]),
    guardrails: z
      .object({
        maxTurns: z.number().int().positive().default(DEFAULT_GUARDRAILS.maxTurns),
        maxOutputTokensPerTurn: z.number().int().positive().default(DEFAULT_GUARDRAILS.maxOutputTokensPerTurn),
        maxCostUsd: z.number().positive().optional(),
        blockedCommands: z.array(z.string()).default(DEFAULT_BLOCKED_COMMANDS),
        allowedPaths: z.array(z.string().min(1)).default(["."]),
        redactEnv: z.array(z.string()).default([]),
        approvalMode: z.enum(["always", "destructive", "never"]).default("destructive"),
      })
      .optional(),
    context: z
      .object({
        caching: z.boolean().default(true),
        compaction: z.boolean().default(true),
        contextEditing: z.boolean().default(false),
        memory: z.boolean().default(false),
      })
      .default(DEFAULT_CONTEXT),
    evals: z.array(evalZ).default([]),
    targets: z.array(targetZ).default(DEFAULT_TARGETS),
    env: z.array(envZ).default([]),
    provenance: z
      .object({
        generator: z.enum(["heuristic", "llm"]).default("heuristic"),
        decreeVersion: z.string().default(DECREE_VERSION),
        createdAt: z.string().optional(),
        profileName: z.string().optional(),
        notes: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .describe("decree-harness spec (decree.json)");

const TOP_LEVEL_KEYS = [
  "$schema",
  "version",
  "name",
  "displayName",
  "description",
  "goal",
  "model",
  "systemPrompt",
  "tools",
  "subagents",
  "guardrails",
  "context",
  "evals",
  "targets",
  "env",
  "provenance",
] as const;

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

/** "My Cool_Agent" -> "my-cool-agent". Empty -> fallback. */
export function toKebab(s: string, fallback = "agent"): string {
  const out = String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return out || fallback;
}

/** "getUser By-ID" -> "get_user_by_id", valid for ^[a-zA-Z0-9_-]{1,64}$. */
export function toToolName(s: string, fallback = "tool"): string {
  const out = String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "");
  return out || fallback;
}

function uniqueName(base: string, taken: Set<string>, sep: string): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `${sep}${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || "(root)";
}

function envStem(specName: string): string {
  return specName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "API";
}

// ---------------------------------------------------------------------------
// validateSpec
// ---------------------------------------------------------------------------

/** Validate + normalize a parsed decree.json. Fills defaults, dedupes tool names, fixes slugs. */
export function validateSpec(input: unknown): { ok: true; spec: HarnessSpec; warnings: string[] } | { ok: false; errors: string[] } {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [`(root): expected a JSON object, received ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`] };
  }
  const warnings: string[] = [];
  const errors: string[] = [];

  // Light pre-pass: tolerate lowercase HTTP methods and a missing name when displayName exists.
  const raw: Record<string, unknown> = { ...input };
  if (raw.name === undefined && typeof raw.displayName === "string" && raw.displayName.trim()) raw.name = raw.displayName;
  if (Array.isArray(raw.tools)) {
    raw.tools = raw.tools.map((t) => {
      if (isPlainObject(t) && isPlainObject(t.http) && typeof t.http.method === "string") {
        return { ...t, http: { ...t.http, method: t.http.method.toUpperCase() } };
      }
      return t;
    });
  }
  for (const k of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(k)) warnings.push(`Unknown field "${k}" ignored.`);
  }

  const parsed = HarnessSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((iss) => {
        const msg = iss.code === "invalid_type" && /received undefined$/.test(iss.message) ? "Required" : iss.message;
        return `${formatPath(iss.path)}: ${msg}`;
      }),
    };
  }
  const p = parsed.data;

  // --- name / displayName --------------------------------------------------
  const name = toKebab(p.name);
  if (name !== p.name) warnings.push(`name: normalized "${p.name}" -> "${name}".`);
  const displayName = p.displayName?.trim() || titleCase(name);

  // --- tools -----------------------------------------------------------------
  const renames = new Map<string, string>(); // original name -> final name (first occurrence wins)
  const taken = new Set<string>();
  const tools: ToolSpec[] = [];
  const serverSeen = new Set<ToolKind>();
  const stem = envStem(name);

  // Reserve server-tool names first so custom tools never collide with them.
  for (const t of p.tools) if (SERVER_KINDS.has(t.kind)) taken.add(t.kind);

  p.tools.forEach((t, i) => {
    const at = `tools[${i}]`;
    const kind = t.kind;
    let finalName: string;

    if (SERVER_KINDS.has(kind)) {
      if (serverSeen.has(kind)) {
        warnings.push(`${at}: duplicate ${kind} tool "${t.name}" dropped.`);
        if (!renames.has(t.name)) renames.set(t.name, kind);
        return;
      }
      serverSeen.add(kind);
      finalName = kind;
      if (t.name !== kind) warnings.push(`${at}.name: ${kind} tools must be named "${kind}"; renamed from "${t.name}".`);
    } else {
      const base = TOOL_NAME_RE.test(t.name) && t.name === toToolName(t.name) ? t.name : toToolName(t.name);
      finalName = uniqueName(base, taken, "_");
      if (finalName !== t.name) warnings.push(`${at}.name: renamed "${t.name}" -> "${finalName}".`);
    }
    taken.add(finalName);
    if (!renames.has(t.name)) renames.set(t.name, finalName);

    const tool: ToolSpec = {
      name: finalName,
      description: t.description,
      kind,
      inputSchema: {},
      readOnly: t.readOnly ?? READ_ONLY_KINDS.has(kind),
      destructive: t.destructive ?? (kind === "write_file" || (kind === "http" && t.http?.method === "DELETE")),
      requiresApproval: t.requiresApproval ?? false,
    };
    if (!tool.description.trim()) warnings.push(`${at}.description: empty; the model relies on tool descriptions to choose tools.`);

    // Bindings
    if (kind === "http") {
      if (!t.http) errors.push(`${at}.http: Required for kind "http"`);
      else {
        const http = { ...t.http } as NonNullable<ToolSpec["http"]>;
        if (!http.baseUrlEnv) {
          http.baseUrlEnv = `${stem}_BASE_URL`;
          warnings.push(`${at}.http.baseUrlEnv: missing; defaulted to ${http.baseUrlEnv}.`);
        }
        if (!http.path.startsWith("/") && !/^https?:\/\//.test(http.path)) http.path = "/" + http.path;
        if (http.auth && http.auth.type !== "none" && !http.auth.env) errors.push(`${at}.http.auth.env: Required when auth.type is "${http.auth.type}"`);
        if (http.auth?.type === "header" && !http.auth.header) errors.push(`${at}.http.auth.header: Required when auth.type is "header"`);
        if (http.bodyParam === undefined) delete http.bodyParam;
        tool.http = http;
      }
    } else if (t.http) warnings.push(`${at}.http: ignored for kind "${kind}".`);

    if (kind === "shell") {
      if (!t.shell) errors.push(`${at}.shell: Required for kind "shell"`);
      else tool.shell = { ...t.shell };
    } else if (t.shell) warnings.push(`${at}.shell: ignored for kind "${kind}".`);

    if (FS_KINDS.has(kind)) tool.fs = t.fs ? { ...t.fs } : { root: "." };
    else if (t.fs) warnings.push(`${at}.fs: ignored for kind "${kind}".`);

    // Input schema
    if (SERVER_KINDS.has(kind)) {
      if (t.inputSchema && Object.keys(t.inputSchema).length) warnings.push(`${at}.inputSchema: ignored for server tool "${kind}".`);
      tool.inputSchema = {};
    } else {
      const res = normalizeInputSchema(t.inputSchema, kind, `${at}.inputSchema`, errors, warnings);
      if (res) {
        if (tool.http) addHttpPathParams(res, tool.http.path, `${at}.inputSchema`, warnings);
        if (tool.shell) addShellParams(res, tool.shell.command, `${at}.inputSchema`, warnings);
        tool.inputSchema = res;
      }
    }

    if (tool.destructive && !tool.requiresApproval) {
      tool.requiresApproval = true;
      warnings.push(`${at}: destructive tool "${finalName}" now requires approval.`);
    }
    if (tool.destructive && tool.readOnly) {
      tool.readOnly = false;
      warnings.push(`${at}: destructive tool "${finalName}" cannot be readOnly; set readOnly=false.`);
    }
    if (t.source !== undefined) tool.source = t.source;
    tools.push(tool);
  });

  const toolNames = new Set(tools.map((t) => t.name));
  const resolveToolRef = (ref: string) => (toolNames.has(ref) ? ref : renames.get(ref));

  // --- subagents -----------------------------------------------------------
  const subTaken = new Set<string>();
  const subagents: SubagentSpec[] = p.subagents.map((s, i) => {
    const at = `subagents[${i}]`;
    const n = uniqueName(toKebab(s.name, "subagent"), subTaken, "-");
    subTaken.add(n);
    if (n !== s.name) warnings.push(`${at}.name: renamed "${s.name}" -> "${n}".`);
    const refs: string[] = [];
    for (const ref of s.tools) {
      const r = resolveToolRef(ref);
      if (!r) warnings.push(`${at}.tools: unknown tool "${ref}" dropped.`);
      else if (!refs.includes(r)) refs.push(r);
    }
    const out: SubagentSpec = { name: n, description: s.description, systemPrompt: s.systemPrompt, tools: refs };
    if (s.model) out.model = s.model;
    if (s.effort) out.effort = s.effort;
    return out;
  });
  const delegateNames = new Set(subagents.map((s) => `delegate_to_${s.name.replace(/-/g, "_")}`));

  // --- evals -----------------------------------------------------------------
  const evalTaken = new Set<string>();
  const evals: EvalCase[] = p.evals.map((e, i) => {
    const at = `evals[${i}]`;
    const id = uniqueName(e.id, evalTaken, "-");
    evalTaken.add(id);
    if (id !== e.id) warnings.push(`${at}.id: duplicate "${e.id}" renamed to "${id}".`);
    const expect: EvalCase["expect"] = {};
    for (const key of ["toolsCalled", "toolsNotCalled"] as const) {
      const list = e.expect[key];
      if (!list) continue;
      expect[key] = list.map((ref) => {
        const r = resolveToolRef(ref);
        if (r) return r;
        if (!delegateNames.has(ref)) warnings.push(`${at}.expect.${key}: unknown tool "${ref}".`);
        return ref;
      });
    }
    if (e.expect.contains) expect.contains = e.expect.contains;
    if (e.expect.notContains) expect.notContains = e.expect.notContains;
    if (e.expect.rubric !== undefined) expect.rubric = e.expect.rubric;
    const out: EvalCase = { id, input: e.input, expect };
    if (e.tags) out.tags = e.tags;
    return out;
  });

  // --- env -----------------------------------------------------------------------
  const env: HarnessSpec["env"] = [];
  const envIndex = new Map<string, number>();
  const pushEnv = (v: HarnessSpec["env"][number], at?: string) => {
    if (!ENV_NAME_RE.test(v.name)) {
      errors.push(`${at ?? "env"}.name: invalid environment variable name "${v.name}"`);
      return;
    }
    if (envIndex.has(v.name)) {
      if (at) warnings.push(`${at}: duplicate env var "${v.name}" dropped.`);
      return;
    }
    envIndex.set(v.name, env.length);
    env.push(v);
  };
  if (!p.env.some((e) => e.name === "ANTHROPIC_API_KEY")) {
    pushEnv({ name: "ANTHROPIC_API_KEY", description: "Anthropic API key", required: true, secret: true });
  }
  p.env.forEach((e, i) => {
    const v: HarnessSpec["env"][number] = { name: e.name, description: e.description, required: e.required, secret: e.secret };
    if (e.default !== undefined) v.default = e.default;
    pushEnv(v, `env[${i}]`);
  });
  for (const t of tools) {
    if (!t.http) continue;
    if (!envIndex.has(t.http.baseUrlEnv)) {
      const v: HarnessSpec["env"][number] = {
        name: t.http.baseUrlEnv,
        description: "Base URL of the API",
        required: !t.http.defaultBaseUrl,
        secret: false,
      };
      if (t.http.defaultBaseUrl) v.default = t.http.defaultBaseUrl;
      pushEnv(v);
      warnings.push(`env: added ${t.http.baseUrlEnv} (referenced by tool "${t.name}").`);
    }
    const authEnv = t.http.auth && t.http.auth.type !== "none" ? t.http.auth.env : undefined;
    if (authEnv && !envIndex.has(authEnv)) {
      pushEnv({ name: authEnv, description: `Credential for the API (${t.http.auth!.type} auth)`, required: true, secret: true });
      warnings.push(`env: added ${authEnv} (referenced by tool "${t.name}").`);
    }
  }

  // --- guardrails / context / targets ------------------------------------------
  const g = p.guardrails;
  const guardrails: HarnessSpec["guardrails"] = g
    ? {
        maxTurns: g.maxTurns,
        maxOutputTokensPerTurn: g.maxOutputTokensPerTurn,
        maxCostUsd: g.maxCostUsd ?? DEFAULT_GUARDRAILS.maxCostUsd,
        blockedCommands: [...new Set(g.blockedCommands)],
        allowedPaths: [...new Set(g.allowedPaths)],
        redactEnv: [...new Set(g.redactEnv)],
        approvalMode: g.approvalMode,
      }
    : { ...DEFAULT_GUARDRAILS, blockedCommands: [...DEFAULT_BLOCKED_COMMANDS], allowedPaths: ["."], redactEnv: [] };

  const context = { ...p.context };
  if (tools.some((t) => t.kind === "memory") && !context.memory) {
    context.memory = true;
    warnings.push(`context.memory: set to true because a memory tool is declared.`);
  }

  const targets = [...new Set(p.targets)];
  if (targets.length === 0) warnings.push(`targets: empty; nothing will be generated.`);

  if (errors.length) return { ok: false, errors };

  const prov = p.provenance;
  const provenance: HarnessSpec["provenance"] = {
    generator: prov?.generator ?? "heuristic",
    decreeVersion: prov?.decreeVersion ?? DECREE_VERSION,
    createdAt: prov?.createdAt ?? new Date().toISOString(),
    profileName: prov?.profileName ?? name,
  };
  if (prov?.notes) provenance.notes = prov.notes;

  const spec: HarnessSpec = {
    ...(p.$schema !== undefined ? { $schema: p.$schema } : {}),
    version: 1,
    name,
    displayName,
    description: p.description,
    goal: p.goal,
    model: { ...p.model },
    systemPrompt: p.systemPrompt,
    tools,
    subagents,
    guardrails,
    context,
    evals,
    targets,
    env,
    provenance,
  };
  return { ok: true, spec, warnings };
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
  kind: ToolKind,
  at: string,
  errors: string[],
  warnings: string[],
): JSONSchema | undefined {
  const s = (schema ?? {}) as JSONSchema;
  const empty = Object.keys(s).length === 0 || (s.type === undefined && s.properties === undefined);
  if (empty) {
    if (FS_KINDS.has(kind)) return structuredClone(FS_DEFAULT_SCHEMAS[kind]!);
    return { ...s, type: "object", properties: {}, required: [] };
  }
  if (s.type !== undefined && s.type !== "object") {
    errors.push(`${at}.type: must be "object" (got ${JSON.stringify(s.type)})`);
    return undefined;
  }
  if (s.properties !== undefined && !isPlainObject(s.properties)) {
    errors.push(`${at}.properties: must be an object`);
    return undefined;
  }
  const out: JSONSchema = { ...s, type: "object", properties: { ...(s.properties ?? {}) } };
  const props = out.properties!;
  const req = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
  const unknownReq = req.filter((r) => !(r in props));
  if (unknownReq.length) warnings.push(`${at}.required: dropped unknown properties ${unknownReq.map((r) => `"${r}"`).join(", ")}.`);
  out.required = [...new Set(req.filter((r) => r in props))];
  return out;
}

function addHttpPathParams(schema: JSONSchema, path: string, at: string, warnings: string[]) {
  const props = schema.properties!;
  const req = (schema.required ??= []);
  for (const m of path.matchAll(/\{([^{}]+)\}/g)) {
    const p = m[1]!;
    if (!(p in props)) {
      props[p] = { type: "string", description: `Path parameter ${p}` };
      warnings.push(`${at}: added missing path parameter "${p}".`);
    }
    if (!req.includes(p)) req.push(p);
  }
}

function addShellParams(schema: JSONSchema, command: string, at: string, warnings: string[]) {
  const props = schema.properties!;
  for (const m of command.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) {
    const p = m[1]!;
    if (!(p in props)) {
      props[p] = { type: "string", description: `Value for {{${p}}}` };
      warnings.push(`${at}: added missing command parameter "${p}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema for editors + stable serialization
// ---------------------------------------------------------------------------

/** JSON Schema for decree.json (written to .decree/schema.json and referenced via $schema). */
export function specJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(HarnessSpecSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://decree.dev/schema/decree.json",
    title: "decree.json",
  };
}

const KEY_ORDER: Record<string, readonly string[]> = {
  root: TOP_LEVEL_KEYS,
  model: ["id", "effort", "subagentId", "thinking"],
  tool: ["name", "description", "kind", "inputSchema", "http", "shell", "fs", "readOnly", "destructive", "requiresApproval", "source"],
  http: ["method", "baseUrlEnv", "defaultBaseUrl", "path", "queryParams", "headerParams", "bodyParam", "auth"],
  auth: ["type", "env", "header"],
  shell: ["command", "cwd", "timeoutMs"],
  fs: ["root", "maxBytes"],
  subagent: ["name", "description", "systemPrompt", "tools", "model", "effort"],
  guardrails: ["maxTurns", "maxOutputTokensPerTurn", "maxCostUsd", "blockedCommands", "allowedPaths", "redactEnv", "approvalMode"],
  context: ["caching", "compaction", "contextEditing", "memory"],
  eval: ["id", "input", "expect", "tags"],
  expect: ["toolsCalled", "toolsNotCalled", "contains", "notContains", "rubric"],
  env: ["name", "description", "required", "secret", "default"],
  provenance: ["generator", "decreeVersion", "createdAt", "profileName", "notes"],
  jsonSchema: ["type", "description", "properties", "required", "items", "enum", "default"],
};

function ordered(obj: unknown, kind: keyof typeof KEY_ORDER): Record<string, unknown> {
  if (!isPlainObject(obj)) return obj as Record<string, unknown>;
  const order = KEY_ORDER[kind]!;
  const out: Record<string, unknown> = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function orderJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(orderJsonSchema);
  if (!isPlainObject(s)) return s;
  const o = ordered(s, "jsonSchema");
  if (isPlainObject(o.properties)) {
    o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, orderJsonSchema(v)]));
  }
  if (o.items !== undefined) o.items = orderJsonSchema(o.items);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(orderJsonSchema);
  return o;
}

/**
 * Serialize a spec for decree.json: `$schema: "./.decree/schema.json"` first, canonical key order,
 * 2-space indent, trailing newline.
 */
export function stringifySpec(spec: HarnessSpec): string {
  const root = ordered({ ...spec, $schema: "./.decree/schema.json" }, "root");
  root.model = ordered(spec.model, "model");
  root.tools = spec.tools.map((t) => {
    const o = ordered(t, "tool");
    o.inputSchema = orderJsonSchema(t.inputSchema);
    if (t.http) {
      const h = ordered(t.http, "http");
      if (t.http.auth) h.auth = ordered(t.http.auth, "auth");
      o.http = h;
    }
    if (t.shell) o.shell = ordered(t.shell, "shell");
    if (t.fs) o.fs = ordered(t.fs, "fs");
    return o;
  });
  root.subagents = spec.subagents.map((s) => ordered(s, "subagent"));
  root.guardrails = ordered(spec.guardrails, "guardrails");
  root.context = ordered(spec.context, "context");
  root.evals = spec.evals.map((e) => {
    const o = ordered(e, "eval");
    o.expect = ordered(e.expect, "expect");
    return o;
  });
  root.env = spec.env.map((e) => ordered(e, "env"));
  root.provenance = ordered(spec.provenance, "provenance");
  return JSON.stringify(root, null, 2) + "\n";
}
