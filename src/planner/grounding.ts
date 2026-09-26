/**
 * Deterministic post-pass over LLM-designed specs: ties bindings to the real project, enforces
 * safety invariants, and falls back to a known-good spec field by field when validation fails.
 */
import type { HarnessSpec, JSONSchema, ProjectProfile, SubagentSpec, ToolKind, ToolSpec } from "../core/types.js";
import { DEFAULT_BLOCKED_COMMANDS, validateSpec } from "../core/spec.js";
import type { HttpDefaults } from "./heuristic.js";
import { isPlainObject, findEndpoint, pathParams, snake, TOOL_NAME_RE, uniq, uniqueName } from "./util.js";

const KINDS = new Set<ToolKind>(["http", "shell", "read_file", "write_file", "list_files", "search", "web_search", "web_fetch", "memory"]);
const SERVER_KINDS = new Set<ToolKind>(["web_search", "web_fetch", "memory"]);
const FS_KINDS = new Set<ToolKind>(["read_file", "write_file", "list_files", "search"]);
const PURE_READ_KINDS = new Set<ToolKind>(["read_file", "list_files", "search", "web_search", "web_fetch"]);

export interface GroundingContext {
  profile?: ProjectProfile;
  /** Defaults used to fill missing http binding fields. */
  httpDefaults?: HttpDefaults;
}

export interface GroundingResult {
  spec: Record<string, unknown>;
  notes: string[];
}

/** True when `raw` looks enough like a spec draft to be worth grounding. */
export function looksLikeDraft(raw: unknown): raw is Record<string, unknown> {
  return isPlainObject(raw) && Array.isArray(raw.tools) && raw.tools.length > 0 && typeof raw.systemPrompt === "string" && raw.systemPrompt.trim().length > 0;
}

function parseSchema(v: unknown): JSONSchema | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t);
      return isPlainObject(parsed) ? (parsed as JSONSchema) : undefined;
    } catch {
      return undefined;
    }
  }
  if (v === undefined || v === null) return {};
  return isPlainObject(v) ? (v as JSONSchema) : undefined;
}

/** Script names referenced by a command template (`npm run x`, `pnpm x`, `make x`, ...). */
export function referencedScripts(command: string): string[] {
  const out: string[] = [];
  const first = command.trim().split(/\s*(?:&&|\|\||;)\s*/);
  for (const part of first) {
    let m = /^(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([^\s{]+)/.exec(part);
    if (m) {
      out.push(m[1]!);
      continue;
    }
    m = /^npm\s+(test|start|stop|restart)\b/.exec(part);
    if (m) {
      out.push(m[1]!);
      continue;
    }
    m = /^(?:pnpm|yarn|bun)\s+(?!add|install|remove|exec|dlx|x\b|i\b|up|upgrade|why|list|ls|run|create|init|link|unlink|publish|pack|outdated|audit|config|store|import|patch|rebuild|prune|dedupe|global|info|view|workspace)([A-Za-z0-9:_-]+)/.exec(part);
    if (m) {
      out.push(m[1]!);
      continue;
    }
    m = /^(?:make|just|task)\s+([A-Za-z0-9:_.-]+)/.exec(part);
    if (m && !m[1]!.startsWith("-")) out.push(m[1]!);
  }
  return out;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function groundTool(raw: unknown, idx: number, ctx: GroundingContext, notes: string[]): ToolSpec | undefined {
  if (!isPlainObject(raw)) {
    notes.push(`Dropped tools[${idx}]: not an object.`);
    return undefined;
  }
  const kind = raw.kind as ToolKind;
  let name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!KINDS.has(kind)) {
    notes.push(`Dropped tool "${name || idx}": unknown kind ${JSON.stringify(raw.kind)}.`);
    return undefined;
  }
  if (!TOOL_NAME_RE.test(name)) name = snake(name).slice(0, 64) || `${kind}_tool`;
  const schema = SERVER_KINDS.has(kind) ? {} : parseSchema(raw.inputSchema);
  if (!schema) {
    notes.push(`Dropped tool "${name}": inputSchema is not valid JSON Schema.`);
    return undefined;
  }
  if (!SERVER_KINDS.has(kind) && schema.type !== undefined && schema.type !== "object") {
    notes.push(`Dropped tool "${name}": inputSchema type must be "object".`);
    return undefined;
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    notes.push(`Dropped tool "${name}": inputSchema.properties must be an object.`);
    return undefined;
  }
  const tool: ToolSpec = {
    name,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    kind,
    inputSchema: schema,
    readOnly: bool(raw.readOnly, false),
    destructive: bool(raw.destructive, false),
    requiresApproval: bool(raw.requiresApproval, false),
    ...(typeof raw.source === "string" && raw.source ? { source: raw.source } : {}),
  };

  if (kind === "http") {
    const h = raw.http;
    if (!isPlainObject(h) || typeof h.path !== "string" || typeof h.method !== "string") {
      notes.push(`Dropped http tool "${name}": missing http binding.`);
      return undefined;
    }
    const method = h.method.toUpperCase() as NonNullable<ToolSpec["http"]>["method"];
    let path = h.path.trim().replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    const profile = ctx.profile;
    const endpoint = profile ? findEndpoint(profile, method, path) : undefined;
    if (profile && profile.apis.length > 0 && !endpoint) {
      notes.push(`Dropped http tool "${name}": ${method} ${path} is not an endpoint of this project.`);
      return undefined;
    }
    if (profile && profile.apis.length === 0) {
      notes.push(`Kept http tool "${name}" (${method} ${path}) unverified: the scan found no API endpoints to check it against.`);
    }
    if (endpoint) {
      // Use the project's own placeholder names when the model's differ only in naming.
      const canonical = endpoint.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
      if (pathParams(canonical).every((p) => isPlainObject(schema.properties) && p in (schema.properties as object)) || pathParams(path).length === 0) {
        path = canonical;
      }
    }
    const d = ctx.httpDefaults;
    const props = isPlainObject(schema.properties) ? (schema.properties as Record<string, JSONSchema>) : {};
    let queryParams = Array.isArray(h.queryParams) ? (h.queryParams as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    let headerParams = Array.isArray(h.headerParams) ? (h.headerParams as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    if (endpoint) {
      const q = endpoint.params.filter((p) => p.in === "query" && p.name in props).map((p) => p.name);
      const hd = endpoint.params.filter((p) => p.in === "header" && p.name in props).map((p) => p.name);
      if (q.length) queryParams = uniq([...(queryParams ?? []), ...q]);
      if (hd.length) headerParams = uniq([...(headerParams ?? []), ...hd]);
    }
    let auth = isPlainObject(h.auth) ? (h.auth as NonNullable<ToolSpec["http"]>["auth"]) : undefined;
    if (!auth || !["bearer", "header", "none"].includes(auth.type)) auth = d?.auth ? { ...d.auth } : { type: "none" };
    if (auth.type !== "none" && !auth.env) auth = d?.auth?.env ? { ...d.auth } : { type: "none" };
    if (auth.type === "header" && !auth.header) auth = { ...auth, header: "X-API-Key" };
    if (auth.type === "none") auth = { type: "none" };
    else auth = { type: auth.type, env: auth.env, ...(auth.type === "header" ? { header: auth.header } : {}) };
    const baseUrlEnv = typeof h.baseUrlEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(h.baseUrlEnv) ? h.baseUrlEnv : d?.baseUrlEnv ?? "API_BASE_URL";
    const defaultBaseUrl = typeof h.defaultBaseUrl === "string" && h.defaultBaseUrl ? h.defaultBaseUrl : d?.defaultBaseUrl;
    tool.http = {
      method,
      baseUrlEnv,
      ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
      path,
      ...(queryParams?.length ? { queryParams } : {}),
      ...(headerParams?.length ? { headerParams } : {}),
      ...(typeof h.bodyParam === "string" && h.bodyParam ? { bodyParam: h.bodyParam } : {}),
      auth,
    };
    if (!tool.source) tool.source = `${endpoint && /openapi|swagger|\.ya?ml$|\.json$/i.test(endpoint.source) ? "openapi" : "route"}:${method} ${path}`;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && tool.readOnly) {
      tool.readOnly = false;
      notes.push(`"${name}": ${method} requests are not read-only; cleared readOnly.`);
    }
    if (method === "DELETE" && !tool.destructive) {
      tool.destructive = true;
      notes.push(`"${name}": DELETE endpoints are treated as destructive.`);
    }
  } else if (kind === "shell") {
    const s = raw.shell;
    if (!isPlainObject(s) || typeof s.command !== "string" || !s.command.trim()) {
      notes.push(`Dropped shell tool "${name}": missing command.`);
      return undefined;
    }
    tool.shell = {
      command: s.command.trim(),
      ...(typeof s.cwd === "string" && s.cwd ? { cwd: s.cwd } : { cwd: "." }),
      ...(typeof s.timeoutMs === "number" && s.timeoutMs > 0 ? { timeoutMs: Math.round(s.timeoutMs) } : {}),
    };
    if (ctx.profile) {
      const known = new Set(ctx.profile.scripts.map((x) => x.name));
      const unknown = referencedScripts(tool.shell.command).filter((x) => !known.has(x));
      if (unknown.length) notes.push(`Warning: shell tool "${name}" references script(s) ${unknown.map((u) => `"${u}"`).join(", ")} not found in the project.`);
    }
  } else if (FS_KINDS.has(kind)) {
    const f = raw.fs;
    tool.fs = {
      root: isPlainObject(f) && typeof f.root === "string" && f.root ? f.root : ".",
      ...(isPlainObject(f) && typeof f.maxBytes === "number" && f.maxBytes > 0 ? { maxBytes: Math.round(f.maxBytes) } : {}),
    };
  }

  if (PURE_READ_KINDS.has(kind)) {
    tool.readOnly = true;
    tool.destructive = false;
  }
  if (kind === "write_file") tool.readOnly = false;
  if (tool.destructive && tool.readOnly) tool.readOnly = false;
  if (tool.destructive && !tool.requiresApproval) {
    tool.requiresApproval = true;
    notes.push(`"${name}" is destructive, so it now requires approval.`);
  }
  if (!tool.description) tool.description = `${name.replace(/_/g, " ")}.`;
  return tool;
}

/** Ground a raw LLM draft against the project. Never throws; returns a spec-shaped object for validateSpec. */
export function groundDraft(raw: Record<string, unknown>, ctx: GroundingContext): GroundingResult {
  const notes: string[] = [];
  const taken = new Set<string>();
  const tools: ToolSpec[] = [];
  (Array.isArray(raw.tools) ? raw.tools : []).forEach((t, i) => {
    const g = groundTool(t, i, ctx, notes);
    if (!g) return;
    const n = uniqueName(g.name, taken);
    if (n !== g.name) notes.push(`Renamed duplicate tool "${g.name}" to "${n}".`);
    g.name = n;
    tools.push(g);
  });
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const subagents: SubagentSpec[] = [];
  for (const s of Array.isArray(raw.subagents) ? raw.subagents : []) {
    if (!isPlainObject(s) || typeof s.name !== "string") continue;
    const list = (Array.isArray(s.tools) ? s.tools : []).filter((x): x is string => typeof x === "string");
    const kept = list.filter((n) => toolByName.has(n) && !toolByName.get(n)!.destructive);
    const removed = list.filter((n) => !kept.includes(n));
    if (removed.length) notes.push(`Subagent "${s.name}": removed ${removed.map((r) => `"${r}"`).join(", ")} (unknown or destructive; subagents cannot ask the user to confirm).`);
    if (!kept.length) {
      notes.push(`Dropped subagent "${s.name}": no usable tools.`);
      continue;
    }
    subagents.push({
      name: s.name,
      description: typeof s.description === "string" ? s.description : "",
      systemPrompt: typeof s.systemPrompt === "string" ? s.systemPrompt : "",
      tools: uniq(kept),
      ...(typeof s.model === "string" && s.model ? { model: s.model } : {}),
      ...(typeof s.effort === "string" ? { effort: s.effort as SubagentSpec["effort"] } : {}),
    });
  }

  const delegateNames = new Set(subagents.map((s) => `delegate_to_${s.name.replace(/-/g, "_")}`));
  const knownRef = (n: string) => toolByName.has(n) || delegateNames.has(n);
  const evals: unknown[] = [];
  for (const e of Array.isArray(raw.evals) ? raw.evals : []) {
    if (!isPlainObject(e) || typeof e.input !== "string") continue;
    const expect = isPlainObject(e.expect) ? { ...e.expect } : {};
    for (const key of ["toolsCalled", "toolsNotCalled"] as const) {
      const refs = Array.isArray(expect[key]) ? (expect[key] as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
      if (!refs) continue;
      const ok = refs.filter(knownRef);
      if (ok.length !== refs.length) notes.push(`Eval "${String(e.id)}": dropped unknown tool reference(s) in ${key}.`);
      if (ok.length) expect[key] = ok;
      else delete expect[key];
    }
    for (const key of Object.keys(expect)) if (expect[key] === null || expect[key] === "") delete expect[key];
    const hasCheck = Object.keys(expect).length > 0;
    if (!hasCheck) {
      notes.push(`Dropped eval "${String(e.id)}": no checks left after grounding.`);
      continue;
    }
    evals.push({ ...e, expect });
  }

  // Env: make sure every referenced variable and the Anthropic key are declared.
  const env: HarnessSpec["env"] = [];
  const seen = new Set<string>();
  const pushEnv = (v: HarnessSpec["env"][number]) => {
    if (seen.has(v.name)) return;
    seen.add(v.name);
    env.push(v);
  };
  for (const v of Array.isArray(raw.env) ? raw.env : []) {
    if (!isPlainObject(v) || typeof v.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) continue;
    pushEnv({
      name: v.name,
      description: typeof v.description === "string" ? v.description : "",
      required: bool(v.required, false),
      secret: bool(v.secret, /KEY|TOKEN|SECRET|PASSWORD/i.test(v.name)),
      ...(typeof v.default === "string" && v.default ? { default: v.default } : {}),
    });
  }
  if (!seen.has("ANTHROPIC_API_KEY")) env.unshift({ name: "ANTHROPIC_API_KEY", description: "Anthropic API key used by the agent", required: true, secret: true });
  seen.add("ANTHROPIC_API_KEY");
  for (const t of tools) {
    if (!t.http) continue;
    pushEnv({
      name: t.http.baseUrlEnv,
      description: "Base URL of the API",
      required: !t.http.defaultBaseUrl,
      secret: false,
      ...(t.http.defaultBaseUrl ? { default: t.http.defaultBaseUrl } : {}),
    });
    if (t.http.auth?.env) pushEnv({ name: t.http.auth.env, description: "API credential", required: true, secret: true });
  }

  // Guardrails: keep the model's choices but never weaker than the baseline.
  const g = isPlainObject(raw.guardrails) ? { ...raw.guardrails } : {};
  const commands = tools.filter((t) => t.shell).map((t) => t.shell!.command);
  const baseline = DEFAULT_BLOCKED_COMMANDS.filter((b) => !commands.some((c) => c.includes(b)));
  const blocked = uniq([...(Array.isArray(g.blockedCommands) ? (g.blockedCommands as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()) : []), ...baseline]);
  const secrets = uniq([
    ...(Array.isArray(g.redactEnv) ? (g.redactEnv as unknown[]).filter((x): x is string => typeof x === "string") : []),
    ...env.filter((e) => e.secret).map((e) => e.name),
    ...(ctx.profile?.envVars.filter((v) => v.secret).map((v) => v.name) ?? []),
  ]);
  const guardrails: Record<string, unknown> = {
    ...g,
    blockedCommands: blocked,
    redactEnv: secrets,
    allowedPaths: Array.isArray(g.allowedPaths) && g.allowedPaths.length ? g.allowedPaths : ["."],
  };
  if (g.approvalMode === "never" && tools.some((t) => t.destructive)) {
    guardrails.approvalMode = "destructive";
    notes.push('approvalMode "never" with destructive tools present; set to "destructive".');
  }

  const context = isPlainObject(raw.context) ? { ...raw.context } : {};
  context.memory = tools.some((t) => t.kind === "memory");

  return { spec: { ...raw, tools, subagents, evals, env, guardrails, context }, notes };
}

/**
 * Validate `candidate`; if it fails, start from `base` (known-valid) and adopt the candidate's fields
 * one group at a time, keeping each only if the result still validates.
 */
export function validateOrMerge(
  candidate: Record<string, unknown>,
  base: HarnessSpec,
): { spec: HarnessSpec; warnings: string[]; merged: boolean; errors: string[] } {
  const first = safeValidate(candidate);
  if (first.ok) return { spec: first.spec, warnings: first.warnings, merged: false, errors: [] };
  let current: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const groups: string[][] = [
    ["tools", "subagents", "systemPrompt", "evals"],
    ["tools", "subagents", "systemPrompt"],
    ["name", "displayName"],
    ["description"],
    ["goal"],
    ["model"],
    ["guardrails"],
    ["context"],
    ["env"],
    ["evals"],
  ];
  const adopted: string[] = [];
  for (const group of groups) {
    if (!group.every((k) => k in candidate) || group.every((k) => adopted.includes(k))) continue;
    const trial = { ...current };
    for (const k of group) trial[k] = candidate[k];
    const r = safeValidate(trial);
    if (r.ok) {
      current = trial;
      adopted.push(...group.filter((k) => !adopted.includes(k)));
    }
  }
  const final = safeValidate(current);
  if (final.ok) return { spec: final.spec, warnings: final.warnings, merged: true, errors: first.errors };
  return { spec: base, warnings: [], merged: true, errors: first.errors };
}

export function safeValidate(input: unknown): { ok: true; spec: HarnessSpec; warnings: string[] } | { ok: false; errors: string[] } {
  try {
    return validateSpec(input);
  } catch (e) {
    return { ok: false, errors: [`validateSpec threw: ${(e as Error).message}`] };
  }
}
