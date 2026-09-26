/**
 * Offline harness-quality scorer: grades a HarnessSpec against the rubric a senior agent engineer
 * would apply in review. Pure and deterministic (no network), so `decree-harness doctor`, tests and
 * the planners can all use it.
 *
 * Rubric (category weights sum to 100):
 * - descriptions (20): every tool says what it does, when to use it, and what it returns, in 1-4
 *   sentences, without restating its name or tool-speak filler.
 * - naming (10): snake_case verb_noun names, no numeric collision suffixes (`create_user_2`).
 * - schemas (10): every input property has a type (or enum) and a real description; required
 *   string inputs carry an example or format.
 * - surface (10): no overlapping tools (same endpoint or command, PUT+PATCH twins), no broken
 *   bindings (regex or prefix-less paths, body-less create/update tools), a focused tool count.
 * - safety (15): destructive actions are dedicated tools gated behind approval; flags are coherent;
 *   no free-form shell; secrets are redacted; subagents get no gated tools.
 * - systemPrompt (15): project facts (stack, test command, API base URL / auth env), exact tool
 *   names, calm tone (no ALL-CAPS directives), under ~700 words.
 * - evals (15): cover the main capabilities, every gated tool (restraint), an out-of-scope request
 *   and a secret-protection case, with realistic phrasing and only real tool names.
 * - subagents (5): present only when they isolate real work; read-only tools; say when to delegate.
 */
import type { HarnessSpec, ProjectProfile, ToolSpec } from "../core/types.js";
import { isPlainObject, normalizePath, TOOL_VERBS } from "./util.js";

export type Severity = "error" | "warning" | "info";

export type QualityCategory = "descriptions" | "naming" | "schemas" | "surface" | "safety" | "systemPrompt" | "evals" | "subagents";

export interface QualityFinding {
  severity: Severity;
  category: QualityCategory;
  /** Stable check id, e.g. "description.when". */
  check: string;
  message: string;
  /** Tool name, eval id, or subagent name the finding is about. */
  target?: string;
}

export interface QualityReport {
  /** 0-100. */
  score: number;
  /** Per-category score 0-100 and its weight in the total. */
  categories: Record<QualityCategory, { score: number; weight: number }>;
  findings: QualityFinding[];
}

export const QUALITY_WEIGHTS: Record<QualityCategory, number> = {
  descriptions: 20,
  naming: 10,
  schemas: 10,
  surface: 10,
  safety: 15,
  systemPrompt: 15,
  evals: 15,
  subagents: 5,
};

/** Soft cap on system prompt length: longer prompts dilute the facts that matter. */
export const PROMPT_WORD_BUDGET = 700;

const SERVER_KINDS = new Set(["web_search", "web_fetch", "memory"]);
const FS_KINDS = new Set(["read_file", "write_file", "list_files", "search"]);

const VERBS = TOOL_VERBS;

const SHOUTING = /\b(MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT|REQUIRED|WARNING|DO NOT|DON'T|UNDER NO CIRCUMSTANCES)\b|!!/;
const PLACEHOLDER_DESC =
  /^(`?[\w.-]+`? \((path|query|header|body|cookie) param(eter)?\)|request body field|json request body|path parameter [\w-]+|value for \{\{[\w-]+\}\}|[\w-]+|(the )?(id|value|string|parameter|param|input|data|body))\.?$/i;
const FILLER = /\bthis (tool|endpoint|function) (allows|lets|enables|is used|can be used)|\ballows you to\b|\bis used to\b|\buse this tool to\b|\ba (helpful|useful) tool\b/i;
const WHEN_RE =
  /\b(use (it|this|them)|call (it|this)|when\b|whenever\b|if (you|the user|a|an|it)\b|before\b|after\b|for (questions|requests|a quick|looking|finding)|to (find|check|confirm|look up|locate|explore|inspect|answer|verify|see))/i;
const RETURNS_RE = /\breturn(s|ed|ing)?\b|\bresponds? with\b|\boutputs?\b|\byields?\b|\bgives back\b|\bshows?\b/i;
const EXAMPLE_RE = /\be\.g\.|\bfor example\b|\bsuch as\b|\blike ['"`]|\b(one|any) of\b/i;
const DESTRUCTIVE_SCRIPT = /\b(deploy|publish|release|migrat|seed|reset|drop|wipe|purge|destroy|rollback)/i;
const DESTRUCTIVE_PATH_WORDS = /(cancel|delete|remove|destroy|purge|erase|wipe|drop|refund|charge|payout|capture|send|email|notify|publish|deploy|revoke|terminate|suspend|ban|transfer|withdraw|rollback|shutdown|execute|approve|reject|void|merge)/i;
const TOGGLE_OFF = /^(un(favorite|favourite|follow|like|star|subscribe|watch|pin|bookmark|block|mute|vote))/i;
const ROBO_INPUT = /\b(id|slug|username|uuid|key|name)\s+123\b|\b123,\s*\w+ 123\b/i;
const MINOR_WORDS = new Set(["a", "an", "the", "calls", "call", "of", "for", "by", "to", "on", "in", "and", "or", "endpoint", "api", "tool", "via"]);

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Split prose into sentences, ignoring abbreviations and code spans. */
export function sentences(text: string): string[] {
  const cleaned = text
    .replace(/`[^`]*`/g, "CODE")
    .replace(/\b(e\.g|i\.e|etc|vs|approx|incl)\./gi, "$1")
    .replace(/\((GET|POST|PUT|PATCH|DELETE|HEAD) [^)]*\)/g, "(ENDPOINT)")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("'`])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

interface Item {
  category: QualityCategory;
  subject: string;
  ok: boolean;
  penalty: number;
  finding?: Omit<QualityFinding, "category">;
}

const SPEC = "(spec)";
const BASE_PENALTY: Record<Severity, number> = { error: 1, warning: 0.3, info: 0.1 };
/** Categories whose findings are graded per tool (the `target` up to the first dot). */
const PER_TOOL = new Set<QualityCategory>(["descriptions", "naming", "schemas", "safety"]);

class Collector {
  items: Item[] = [];
  /**
   * Record a pass/fail check. A failure multiplies its subject's score by (1 - penalty); penalty is
   * 1 for errors, 0.3 for warnings and 0.1 for info, times `scale`. Subjects are tools for per-tool
   * categories, evals for per-eval checks, and the spec as a whole otherwise.
   */
  check(category: QualityCategory, ok: boolean, finding: Omit<QualityFinding, "category">, scale = 1, subject?: string): void {
    const subj = subject ?? (PER_TOOL.has(category) && finding.target ? finding.target.split(".")[0]! : SPEC);
    const penalty = Math.min(1, BASE_PENALTY[finding.severity] * scale);
    this.items.push({ category, subject: subj, ok, penalty, finding: ok ? undefined : finding });
  }

  /** Category score 0..1: the mean over per-item subjects, averaged 50/50 with the spec-level subject. */
  score(category: QualityCategory): number {
    const subjects = new Map<string, number>();
    for (const i of this.items) {
      if (i.category !== category) continue;
      const cur = subjects.get(i.subject) ?? 1;
      subjects.set(i.subject, i.ok ? cur : cur * (1 - i.penalty));
    }
    const spec = subjects.get(SPEC);
    subjects.delete(SPEC);
    const vals = [...subjects.values()];
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    if (mean === undefined) return spec ?? 1;
    if (spec === undefined) return mean;
    return (mean + spec) / 2;
  }
}

function isGated(t: ToolSpec): boolean {
  return t.requiresApproval || t.destructive;
}

/** True when a tool's binding says it can do irreversible or externally visible damage. */
function looksDestructive(t: ToolSpec): boolean {
  if (t.kind === "write_file") return true;
  if (t.kind === "http" && t.http) {
    if (t.http.method === "DELETE") return !TOGGLE_OFF.test(t.name);
    if (t.http.method !== "GET" && t.http.method !== "HEAD" && t.http.method !== "OPTIONS") {
      const statics = t.http.path
        .split("/")
        .filter((s) => s && !/^[{:]/.test(s))
        .join("/");
      return DESTRUCTIVE_PATH_WORDS.test(statics);
    }
    return false;
  }
  if (t.kind === "shell" && t.shell) return DESTRUCTIVE_SCRIPT.test(t.shell.command) || DESTRUCTIVE_SCRIPT.test(t.name);
  return false;
}

// ---------------------------------------------------------------------------
// Tool checks
// ---------------------------------------------------------------------------

function checkDescription(c: Collector, t: ToolSpec): void {
  const d = (t.description ?? "").trim();
  const cat: QualityCategory = "descriptions";
  if (!d) {
    c.check(cat, false, { severity: "error", check: "description.missing", message: "Tool has no description; the model picks tools by their descriptions.", target: t.name });
    return;
  }
  const ss = sentences(d);
  c.check(
    cat,
    ss.length >= 1 && ss.length <= 4,
    { severity: "warning", check: "description.length", message: `Description has ${ss.length} sentences; keep it to 1-4 focused sentences.`, target: t.name },
  );
  const first = ss[0] ?? d;
  const nameWords = new Set(words(t.name));
  const firstWords = words(first.replace(/\(ENDPOINT\)/g, "")).filter((w) => !MINOR_WORDS.has(w));
  const restates = firstWords.length > 0 && firstWords.length <= 4 && firstWords.every((w) => nameWords.has(w) || nameWords.has(w.replace(/s$/, "")) || nameWords.has(w + "s"));
  // A bare restatement ("Get user.") is a real gap; a short opener followed by when/returns guidance is only a nit.
  const substantial = ss.length >= 3 && WHEN_RE.test(d) && RETURNS_RE.test(d);
  c.check(cat, !restates, {
    severity: substantial ? "info" : "warning",
    check: "description.restates-name",
    message: `Opens by restating the tool name ("${first}"); say what it does for the model instead.`,
    target: t.name,
  });
  c.check(cat, !FILLER.test(d), { severity: "warning", check: "description.filler", message: "Contains tool-speak filler (\"this tool allows you to…\"); state the behavior directly.", target: t.name });
  c.check(cat, WHEN_RE.test(d), { severity: "warning", check: "description.when", message: "Does not say when to use it; trigger conditions measurably improve tool choice.", target: t.name }, 1.5);
  if (!SERVER_KINDS.has(t.kind)) {
    c.check(cat, RETURNS_RE.test(d), { severity: "warning", check: "description.returns", message: "Does not say what it returns.", target: t.name });
  }
  if (isGated(t)) {
    c.check(
      cat,
      /\b(confirm|approv|explicit|irreversible|cannot be undone|hard to undo|permanent)/i.test(d),
      { severity: "warning", check: "description.gated", message: "Gated tool's description does not tell the model to get the user's confirmation first.", target: t.name },
    );
  }
}

function checkName(c: Collector, t: ToolSpec, all: ToolSpec[]): void {
  const cat: QualityCategory = "naming";
  if (SERVER_KINDS.has(t.kind)) return;
  c.check(cat, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(t.name), { severity: "error", check: "name.snake_case", message: `"${t.name}" is not snake_case.`, target: t.name });
  const first = t.name.split("_")[0] ?? "";
  c.check(cat, VERBS.has(first) && t.name.includes("_"), {
    severity: "warning",
    check: "name.verb_noun",
    message: `"${t.name}" does not read as verb_noun (e.g. list_orders, cancel_order).`,
    target: t.name,
  });
  const base = t.name.replace(/_\d+$/, "");
  const collides = base !== t.name && all.some((o) => o.name === base);
  c.check(cat, !/_\d+$/.test(t.name), {
    severity: "error",
    check: "name.collision-suffix",
    message: `"${t.name}" carries a numeric suffix${collides ? ` to dodge a clash with ${base}` : ""}; name it by what distinguishes it (e.g. create_private_user vs create_user).`,
    target: t.name,
  });
}

function describedEnough(desc: unknown): boolean {
  if (typeof desc !== "string") return false;
  const d = desc.trim();
  if (!d || PLACEHOLDER_DESC.test(d)) return false;
  return words(d).length >= 2;
}

function checkSchema(c: Collector, t: ToolSpec): void {
  const cat: QualityCategory = "schemas";
  if (SERVER_KINDS.has(t.kind)) return;
  const props = isPlainObject(t.inputSchema.properties) ? (t.inputSchema.properties as Record<string, Record<string, unknown>>) : {};
  const required = new Set(Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : []);
  for (const [k, v] of Object.entries(props)) {
    const target = `${t.name}.${k}`;
    const typed = v && (v.type !== undefined || Array.isArray(v.enum) || Array.isArray(v.anyOf) || Array.isArray(v.oneOf) || v.const !== undefined);
    c.check(cat, !!typed, { severity: "warning", check: "param.type", message: `Input "${k}" has no type or enum.`, target });
    c.check(cat, describedEnough(v?.description), {
      severity: "warning",
      check: "param.description",
      message: `Input "${k}" is not meaningfully described${typeof v?.description === "string" ? ` ("${v.description}")` : ""}.`,
      target,
    });
    const isString = v?.type === "string" || v?.type === undefined;
    if (required.has(k) && isString && !Array.isArray(v?.enum) && t.kind !== "write_file") {
      const hasExample = Array.isArray(v?.examples) || v?.format !== undefined || v?.default !== undefined || v?.pattern !== undefined || EXAMPLE_RE.test(String(v?.description ?? ""));
      c.check(cat, hasExample, { severity: "info", check: "param.example", message: `Required input "${k}" has no example or format; show the model what a valid value looks like.`, target });
    }
  }
}

function checkSafety(c: Collector, t: ToolSpec): void {
  const cat: QualityCategory = "safety";
  if (t.destructive) {
    c.check(cat, t.requiresApproval, { severity: "error", check: "safety.destructive-ungated", message: "Destructive tool does not require approval.", target: t.name });
  }
  if (looksDestructive(t)) {
    c.check(cat, isGated(t), { severity: "error", check: "safety.ungated-action", message: "Looks irreversible or externally visible but is neither destructive nor approval-gated.", target: t.name });
  }
  if (t.readOnly) {
    const mutatingHttp = t.kind === "http" && t.http && !["GET", "HEAD", "OPTIONS"].includes(t.http.method);
    const mutatingKind = t.kind === "write_file" || t.kind === "memory";
    c.check(cat, !mutatingHttp && !mutatingKind && !t.destructive, {
      severity: "error",
      check: "safety.readonly-mutates",
      message: "Marked readOnly but can change state; the runtime runs readOnly tools in parallel without approval.",
      target: t.name,
    });
  }
  if (t.kind === "shell" && t.shell) {
    const cmd = t.shell.command.trim();
    const freeForm = /^\{\{/.test(cmd) || /\b(sh|bash|zsh)\s+-c\s+\{\{/.test(cmd) || /\beval\s+\{\{/.test(cmd) || /^(npx|uvx|bunx)\s+\{\{/.test(cmd);
    c.check(cat, !freeForm, { severity: "error", check: "safety.free-form-shell", message: `Shell tool runs arbitrary input (\`${cmd}\`); expose fixed commands with narrow parameters.`, target: t.name });
  }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

function checkSurface(c: Collector, spec: HarnessSpec): void {
  const cat: QualityCategory = "surface";
  const tools = spec.tools;
  const byEndpoint = new Map<string, string[]>();
  const byPath = new Map<string, Set<string>>();
  for (const t of tools) {
    if (!t.http) continue;
    const key = `${t.http.method} ${normalizePath(t.http.path)}`;
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), t.name]);
    const p = normalizePath(t.http.path);
    if (!byPath.has(p)) byPath.set(p, new Set());
    byPath.get(p)!.add(t.http.method);
  }
  for (const [key, names] of byEndpoint) {
    c.check(cat, names.length === 1, { severity: "error", check: "surface.duplicate-endpoint", message: `${names.join(", ")} all call ${key}.`, target: names[0] });
  }
  for (const [p, methods] of byPath) {
    if (methods.has("PUT") && methods.has("PATCH")) {
      c.check(cat, false, { severity: "warning", check: "surface.put-patch", message: `Both PUT and PATCH ${p} are tools; the model cannot tell them apart. Keep one update tool.` });
    }
  }
  const byCommand = new Map<string, string[]>();
  for (const t of tools) if (t.shell) byCommand.set(t.shell.command, [...(byCommand.get(t.shell.command) ?? []), t.name]);
  for (const [cmd, names] of byCommand) {
    c.check(cat, names.length === 1, { severity: "error", check: "surface.duplicate-command", message: `${names.join(", ")} all run \`${cmd}\`.`, target: names[0] });
  }
  const firstSentences = new Map<string, string[]>();
  for (const t of tools) {
    const s = (sentences(t.description)[0] ?? "").toLowerCase();
    if (s.length < 12) continue;
    firstSentences.set(s, [...(firstSentences.get(s) ?? []), t.name]);
  }
  for (const [s, names] of firstSentences) {
    if (names.length > 1) c.check(cat, false, { severity: "warning", check: "surface.same-description", message: `${names.join(", ")} open with the same sentence ("${s}"); make the difference obvious.` });
  }
  for (const t of tools) {
    if (!t.http) continue;
    const path = t.http.path;
    const broken = /[\^$?*]|\(\?P?</.test(path) || /^\/\{[^}]+\}/.test(path) || (path === "/" && t.http.method !== "GET");
    c.check(cat, !broken, { severity: "error", check: "surface.suspicious-path", message: `Path "${path}" looks like a regex or is missing its router prefix; the tool would call the wrong URL.`, target: t.name }, 1, t.name);
    const props = isPlainObject(t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [];
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const bodyInputs = props.filter((p) => !pathParams.includes(p) && !(t.http!.queryParams ?? []).includes(p) && !(t.http!.headerParams ?? []).includes(p));
    const needsBody = (t.http.method === "POST" || t.http.method === "PUT" || t.http.method === "PATCH") && /^(create|update|add|submit|register|replace|upsert|set)_/.test(t.name);
    if (needsBody) {
      c.check(cat, bodyInputs.length > 0, { severity: "error", check: "surface.no-body", message: `${t.http.method} tool has no body inputs, so it can never send the data it needs.`, target: t.name }, 1, t.name);
    }
  }
  const hasHttp = tools.some((t) => t.kind === "http");
  const write = tools.some((t) => t.kind === "write_file");
  const checks = tools.filter((t) => t.kind === "shell" && !isGated(t));
  const readOnlyGoal = /\bread[- ]?only\b|\bwithout (making )?changes\b|\bno (writes|changes)\b/i.test(spec.goal);
  if (!hasHttp && !readOnlyGoal) {
    c.check(cat, write, { severity: "info", check: "surface.code-agent", message: "No API and no write_file: a codebase without an API is usually best served by a coding agent with a gated write_file." }, 3);
  }
  if (write) {
    c.check(cat, checks.length > 0, { severity: "warning", check: "surface.verification", message: "The agent can edit files but has no test, lint or build tool to verify its changes." }, 2);
  }
  const client = tools.filter((t) => !SERVER_KINDS.has(t.kind)).length;
  c.check(cat, client <= 30, { severity: "warning", check: "surface.too-many", message: `${client} client tools; past ~30 tool choice degrades. Trim to the goal or use tool search.` }, 2);
  c.check(cat, tools.length > 0, { severity: "error", check: "surface.empty", message: "No tools." });
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function checkPrompt(c: Collector, spec: HarnessSpec, profile?: ProjectProfile): void {
  const cat: QualityCategory = "systemPrompt";
  const p = spec.systemPrompt ?? "";
  const n = wordCount(p);
  c.check(cat, n <= PROMPT_WORD_BUDGET, { severity: n > 1000 ? "error" : "warning", check: "prompt.length", message: `System prompt is ${n} words; keep it under ~${PROMPT_WORD_BUDGET}.` }, 2);
  c.check(cat, n >= 80, { severity: "warning", check: "prompt.too-short", message: `System prompt is only ${n} words; it needs the project facts the agent can't discover cheaply.` });
  const shout = SHOUTING.exec(p);
  c.check(cat, !shout, { severity: "warning", check: "prompt.shouting", message: `Uses shouting ("${shout?.[0]}"); current models follow calm instructions closely and over-trigger on capitals.` }, 2);

  const names = spec.tools.map((t) => t.name);
  const mentioned = names.filter((nm) => new RegExp(`\`${nm}\``).test(p) || new RegExp(`\\b${nm}\\b`).test(p));
  c.check(cat, mentioned.length >= Math.min(3, names.length), { severity: "warning", check: "prompt.tool-names", message: "Refers to few tools by their exact names; tool guidance should use the real names." });
  const known = new Set([
    ...names,
    ...spec.env.map((e) => e.name),
    ...spec.subagents.flatMap((s) => [s.name, `delegate_to_${s.name.replace(/-/g, "_")}`]),
    ...spec.tools.flatMap((t) => (isPlainObject(t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [])),
  ]);
  for (const m of p.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const ref = m[1]!;
    if (known.has(ref)) continue;
    if (!VERBS.has(ref.split("_")[0]!)) continue;
    c.check(cat, false, { severity: "error", check: "prompt.unknown-tool", message: `Refers to \`${ref}\`, which is not a tool in the spec.`, target: ref });
  }
  const gated = spec.tools.filter((t) => isGated(t) && t.kind !== "write_file");
  for (const t of gated) {
    c.check(cat, p.includes(t.name), { severity: "warning", check: "prompt.gated-tool", message: `Gated tool ${t.name} is not mentioned where the prompt explains what needs confirmation.`, target: t.name }, 0.3);
  }

  const test = spec.tools.find((t) => t.kind === "shell" && /^run_tests?\b|^test/.test(t.name));
  if (test) {
    c.check(cat, p.includes(test.name) || (!!test.shell && p.includes(test.shell.command.replace(/\s*\{\{[^}]+\}\}/g, "").trim())), {
      severity: "warning",
      check: "prompt.test-command",
      message: "Does not say how tests run.",
    });
  }
  const http = spec.tools.find((t) => t.http);
  if (http) {
    c.check(cat, p.includes(http.http!.baseUrlEnv), { severity: "warning", check: "prompt.base-url", message: `Does not name the API base URL env var (${http.http!.baseUrlEnv}).` });
    const authEnv = http.http!.auth && http.http!.auth.type !== "none" ? http.http!.auth.env : undefined;
    if (authEnv) c.check(cat, p.includes(authEnv), { severity: "warning", check: "prompt.auth", message: `Does not explain API authentication (${authEnv}).` });
  }
  if (!http) {
    c.check(cat, !/\b(the|its real|through its) API\b|\bAPI (base URL|endpoints?|calls?)\b/.test(p), { severity: "warning", check: "prompt.phantom-api", message: "Talks about an API the harness has no tools for." });
  }
  if (spec.tools.some((t) => t.kind === "write_file")) {
    const verifiers = spec.tools.filter((t) => t.kind === "shell" && !isGated(t)).map((t) => t.name);
    c.check(cat, verifiers.some((v) => p.includes(v)), { severity: "warning", check: "prompt.verify", message: "Can edit files but the prompt never says which tool verifies a change." });
  }
  c.check(cat, /\b(secret|token|credential|api key|env(ironment)? var)/i.test(p), { severity: "warning", check: "prompt.secrets", message: "Says nothing about protecting secrets." });
  c.check(cat, /\b(out of scope|outside (this|your|the)|not (part of|within)|can't help|cannot help|scope)\b/i.test(p), { severity: "info", check: "prompt.scope", message: "Does not say what to do with out-of-scope requests." });
  if (gated.length) {
    c.check(cat, /\bconfirm/i.test(p), { severity: "warning", check: "prompt.confirmation", message: "Has gated tools but never tells the agent to get confirmation." });
  }

  if (profile) {
    const stack = [profile.primaryLanguage, ...profile.frameworks, ...profile.languages.slice(0, 2).map((l) => l.name)].filter((x): x is string => !!x);
    c.check(cat, !stack.length || stack.some((s) => p.toLowerCase().includes(s.toLowerCase())), { severity: "warning", check: "prompt.stack", message: "Does not mention the project's stack." });
    c.check(cat, p.toLowerCase().includes(profile.name.toLowerCase()), { severity: "info", check: "prompt.project-name", message: "Does not name the project." });
    const models = profile.database?.models ?? [];
    if (models.length) {
      c.check(cat, models.some((m) => new RegExp(`\\b${m.replace(/[^A-Za-z0-9]/g, "")}s?\\b`, "i").test(p)), {
        severity: "warning",
        check: "prompt.domain",
        message: "Does not describe the domain (none of the data models are mentioned).",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

function httpResource(path: string): string {
  const segs = path.split("/").filter((s) => s && !/^[{:]/.test(s) && !/^(api|v\d+(\.\d+)?|rest)$/i.test(s));
  return (segs[0] ?? "").toLowerCase();
}

function checkEvals(c: Collector, spec: HarnessSpec): void {
  const cat: QualityCategory = "evals";
  const evals = spec.evals;
  const names = new Set(spec.tools.map((t) => t.name));
  const delegates = new Set(spec.subagents.map((s) => `delegate_to_${s.name.replace(/-/g, "_")}`));
  c.check(cat, evals.length >= 5, { severity: "warning", check: "evals.count", message: `Only ${evals.length} evals; aim for 6-14 covering tool choice, restraint, scope and secrets.` }, 2);
  c.check(cat, evals.length <= 16, { severity: "info", check: "evals.too-many", message: `${evals.length} evals; keep the suite focused so it runs cheaply.` });

  for (const e of evals) {
    for (const ref of [...(e.expect.toolsCalled ?? []), ...(e.expect.toolsNotCalled ?? [])]) {
      c.check(cat, names.has(ref) || delegates.has(ref), { severity: "error", check: "evals.unknown-tool", message: `Eval references unknown tool "${ref}".`, target: e.id }, 1, e.id);
    }
    const checks = (e.expect.toolsCalled?.length ?? 0) + (e.expect.contains?.length ?? 0) + (e.expect.rubric ? 1 : 0);
    c.check(cat, checks > 0, { severity: "warning", check: "evals.no-assertion", message: "Eval asserts nothing positive (no toolsCalled, contains, or rubric).", target: e.id }, 1, e.id);
    const robotic =
      ROBO_INPUT.test(e.input) ||
      [...names].some((n) => n.includes("_") && e.input.includes(n)) ||
      /\bthe the\b/i.test(e.input) ||
      /^please [a-z]+ [a-z]+ \d+\.?$/i.test(e.input.trim()) ||
      /\b\^|\{\w+\}/.test(e.input);
    c.check(cat, !robotic, { severity: "warning", check: "evals.realism", message: `Input reads like a template ("${e.input}"); write what a real user would type, with plausible ids.`, target: e.id }, 1.5, e.id);
  }

  const gated = spec.tools.filter((t) => isGated(t) && t.kind !== "write_file");
  const uncovered = gated.filter(
    (t) => !evals.some((e) => (e.expect.toolsNotCalled ?? []).includes(t.name) && (/confirm|approv|ask/i.test(e.expect.rubric ?? "") || (e.tags ?? []).some((x) => /safety|approval/.test(x)))),
  );
  if (gated.length) {
    // Proportional: missing restraint evals for half the gated tools costs a full warning's worth x2.
    c.check(
      cat,
      uncovered.length === 0,
      { severity: "warning", check: "evals.gated-coverage", message: `No eval checks that ${uncovered.map((t) => t.name).join(", ")} wait${uncovered.length === 1 ? "s" : ""} for confirmation.` },
      (4 * uncovered.length) / gated.length,
    );
  }
  const scope = evals.some((e) => (e.tags ?? []).includes("scope") || /out-of-scope|off-topic/.test(e.id));
  c.check(cat, scope, { severity: "warning", check: "evals.out-of-scope", message: "No out-of-scope eval." }, 2);
  const secret = evals.some((e) => (e.tags ?? []).some((x) => /secret/.test(x)) || /secret|leak/.test(e.id));
  c.check(cat, secret, { severity: "warning", check: "evals.secrets", message: "No secret-protection eval." }, 2);

  // Capability coverage: main API resources, tests, code reading.
  const readHttp = spec.tools.filter((t) => t.http && t.readOnly);
  const resources = new Map<string, string[]>();
  for (const t of readHttp) {
    const r = httpResource(t.http!.path);
    if (!r || /^(health|healthz|ping|status|me|user|session|auth|login|utils?|admin|internal)$/.test(r) || /health|ping/.test(t.name)) continue;
    if (/checkout|callback|redirect|oauth|webhook/.test(t.http!.path)) continue;
    resources.set(r, [...(resources.get(r) ?? []), t.name]);
  }
  const major = [...resources.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  const called = new Set(evals.flatMap((e) => e.expect.toolsCalled ?? []));
  for (const [r, ts] of major) {
    c.check(cat, ts.some((n) => called.has(n)), { severity: "warning", check: "evals.capability", message: `No eval exercises the ${r} API (${ts.join(", ")}).`, target: r }, 1.5);
  }
  const test = spec.tools.find((t) => t.kind === "shell" && /^run_tests?\b/.test(t.name));
  if (test) c.check(cat, called.has(test.name), { severity: "warning", check: "evals.tests", message: `No eval checks that the agent runs ${test.name}.` });
  const fs = spec.tools.some((t) => t.kind === "search" || t.kind === "read_file");
  if (fs) {
    c.check(cat, evals.some((e) => (e.tags ?? []).some((x) => /grounding|code/.test(x))), { severity: "info", check: "evals.grounding", message: "No code-grounding eval (answer with file:line evidence)." });
  }
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

function checkSubagents(c: Collector, spec: HarnessSpec): void {
  const cat: QualityCategory = "subagents";
  const byName = new Map(spec.tools.map((t) => [t.name, t]));
  const client = spec.tools.filter((t) => !SERVER_KINDS.has(t.kind));
  if (!spec.subagents.length) {
    // Not having subagents is the right default; only a very large read surface argues for one.
    const reads = client.filter((t) => t.readOnly).length;
    c.check(cat, reads < 25, { severity: "info", check: "subagents.missing", message: `${reads} read-only tools and no subagent: bulky reads will crowd the main context.` });
    return;
  }
  for (const s of spec.subagents) {
    const tools = s.tools.map((n) => byName.get(n)).filter((t): t is ToolSpec => !!t);
    for (const t of tools) {
      c.check(cat, !isGated(t), { severity: "error", check: "subagents.gated-tool", message: `Subagent ${s.name} has gated tool ${t.name}; subagents cannot ask the user to confirm.`, target: s.name });
    }
    c.check(cat, /\b(delegate|when|for)\b/i.test(s.description), { severity: "warning", check: "subagents.description", message: "Description does not say when to delegate.", target: s.name });
    c.check(cat, tools.length > 0, { severity: "error", check: "subagents.no-tools", message: "Subagent has no tools.", target: s.name });
    const httpReads = tools.filter((t) => t.kind === "http").length;
    const justified = client.length >= 14 || httpReads >= 10 || (tools.length >= 3 && tools.length < client.length && client.length >= 10);
    c.check(cat, justified, {
      severity: "warning",
      check: "subagents.justified",
      message: `Subagent ${s.name} on a ${client.length}-tool surface: the extra model loop costs more than it isolates. Work directly instead.`,
      target: s.name,
    }, 2);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Grade a harness against the rubric. `profile` (from .decree/profile.json) enables project-fact checks. */
export function scoreHarness(spec: HarnessSpec, profile?: ProjectProfile): QualityReport {
  const c = new Collector();
  for (const t of spec.tools) {
    checkDescription(c, t);
    checkName(c, t, spec.tools);
    checkSchema(c, t);
    checkSafety(c, t);
  }
  const redact = new Set(spec.guardrails.redactEnv);
  for (const e of spec.env) {
    if (e.secret) c.check("safety", redact.has(e.name), { severity: "error", check: "safety.redact", message: `Secret env var ${e.name} is not in guardrails.redactEnv.`, target: e.name });
  }
  c.check("safety", spec.guardrails.approvalMode !== "never" || !spec.tools.some(isGated), { severity: "error", check: "safety.approval-mode", message: 'approvalMode "never" disables every gate.' });
  checkSurface(c, spec);
  checkPrompt(c, spec, profile);
  checkEvals(c, spec);
  checkSubagents(c, spec);

  const categories = {} as QualityReport["categories"];
  let total = 0;
  for (const [cat, weight] of Object.entries(QUALITY_WEIGHTS) as [QualityCategory, number][]) {
    const score = c.score(cat);
    categories[cat] = { score: Math.round(score * 100), weight };
    total += score * weight;
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const findings = c.items
    .filter((i) => i.finding)
    .map((i) => ({ category: i.category, ...i.finding! }))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  return { score: Math.round(total), categories, findings };
}

/** One-line summary per category, e.g. for `decree-harness doctor`. */
export function formatQualityReport(r: QualityReport, maxFindings = 10): string {
  const lines = [`Harness quality: ${r.score}/100`];
  lines.push(
    "  " +
      (Object.entries(r.categories) as [QualityCategory, { score: number }][])
        .map(([k, v]) => `${k} ${v.score}`)
        .join(" · "),
  );
  for (const f of r.findings.slice(0, maxFindings)) lines.push(`  ${f.severity === "error" ? "✗" : f.severity === "warning" ? "!" : "·"} ${f.target ? `${f.target}: ` : ""}${f.message}`);
  if (r.findings.length > maxFindings) lines.push(`  … ${r.findings.length - maxFindings} more`);
  return lines.join("\n");
}
