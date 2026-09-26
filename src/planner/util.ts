/** Small helpers shared by the heuristic and LLM planners. */
import type { ApiEndpoint, JSONSchema, ProjectProfile } from "../core/types.js";

export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Leading verbs that make a tool name read as verb_noun (shared by the planner and the quality scorer). */
export const TOOL_VERBS: ReadonlySet<string> = new Set(
  (
    "get list create update delete remove search find fetch read write run check format fix add cancel refund send submit login logout " +
    "register signup favorite unfavorite follow unfollow approve reject publish unpublish deploy reset recover test upload download export import sync " +
    "trigger start stop restart archive unarchive restore validate verify preview render generate build lint compile query count describe show " +
    "assign unassign merge close open reopen lock unlock enable disable invite accept decline revoke rotate subscribe unsubscribe like unlike " +
    "star unstar pin unpin mark move copy rename tag untag attach detach clone ping set replace upsert patch apply rollback migrate seed " +
    "schedule complete resolve transfer charge capture void pay confirm retry estimate calculate convert translate summarize analyze explain " +
    "inspect view watch unwatch bookmark unbookmark block unblock mute unmute vote upvote downvote report flag notify email message reply " +
    "comment share join leave ban unban suspend activate deactivate authenticate authorize refresh upgrade downgrade install uninstall provision " +
    "scale execute invoke call post put delegate web memory lookup diff compare review typecheck bump release tail stream save load " +
    "print parse encode decode sign unsign hash dump sort filter map evaluate benchmark profile measure clean prune purge wipe drop reindex"
  ).split(/\s+/),
);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function kebab(s: string): string {
  return (
    s
      .replace(/^@[^/]+\//, "") // npm scope
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const ACRONYMS = new Set(["api", "ai", "ui", "ux", "db", "id", "sql", "http", "cli", "mcp", "sdk", "url", "crm", "erp", "cms", "llm", "ml", "ci", "cd"]);

export function titleCase(s: string): string {
  return kebab(s)
    .split("-")
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/** "an" before a vowel sound (approximate), "a" otherwise. */
export function article(word: string): string {
  return /^[aeio]|^u(?!ni|se|sa|su)/i.test(word.trim()) ? "an" : "a";
}

/** Words that pad repository names without identifying the project ("-example-app", "-template"). */
const GENERIC_NAME_WORDS = new Set(["example", "examples", "app", "application", "template", "starter", "boilerplate", "demo", "sample", "project", "repo", "kit", "skeleton", "scaffold"]);

/**
 * The identifying words of a project name: "node-express-realworld-example-app" -> ["node", "express", "realworld"].
 * Generic trailing words are dropped and the result is capped at three words.
 */
export function coreNameWords(name: string): string[] {
  const all = kebab(name).split("-").filter(Boolean);
  let ws = [...all];
  while (ws.length > 1 && GENERIC_NAME_WORDS.has(ws[ws.length - 1]!)) ws.pop();
  ws = ws.filter((w, i) => i === 0 || !GENERIC_NAME_WORDS.has(w));
  return (ws.length ? ws : all).slice(0, 3);
}

/** Env-var prefix for the project, e.g. "acme-orders" -> "ACME_ORDERS", "node-express-realworld-example-app" -> "NODE_EXPRESS_REALWORLD". */
export function envPrefix(profile: ProjectProfile): string {
  const p = snake(coreNameWords(profile.name).join("-")).toUpperCase();
  return /^[A-Z]/.test(p) ? p : `APP_${p}`;
}

/**
 * Route paths as a client calls them: Django/regex routes lose their anchors and optional-slash
 * markers (`/^api/^articles/feed/?$` -> `/api/articles/feed/`), `:id` / `<int:id>` become `{id}`.
 */
export function cleanRoutePath(path: string): string {
  let p = path.trim();
  if (!/[\^$?]|\(\?P?</.test(p)) return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  p = p
    .replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>[^)]*\)/g, "{$1}")
    .replace(/<(?:[^:>]+:)?([A-Za-z_][A-Za-z0-9_]*)>/g, "{$1}")
    .replace(/\^/g, "")
    .replace(/\$$/g, "")
    .replace(/\/\?(?=\/|$)/g, "/")
    .replace(/\?$/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  return p.startsWith("/") ? p : "/" + p;
}

/** Truncate a tool name to 64 chars and make it unique against `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = (base || "tool").slice(0, 64).replace(/_+$/, "");
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Normalize an API path for comparison: `:id` -> `{id}`, param names erased, trailing slash removed. */
export function normalizePath(path: string): string {
  let p = cleanRoutePath(path).split("?")[0]!;
  p = p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}").replace(/<(?:[^:>]+:)?([^>]+)>/g, "{$1}");
  p = p.replace(/\{[^}]*\}/g, "{}");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p.toLowerCase();
}

export function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

export function findEndpoint(profile: ProjectProfile, method: string, path: string): ApiEndpoint | undefined {
  const key = endpointKey(method, path);
  return profile.apis.find((e) => endpointKey(e.method, e.path) === key);
}

/** Path params named in `{x}` placeholders. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/** The "resource" an endpoint belongs to: first tag, else first meaningful path segment. */
export function resourceOf(e: ApiEndpoint): string {
  if (e.tags && e.tags.length && e.tags[0]) return e.tags[0].toLowerCase();
  const segs = e.path
    .split("/")
    .filter((s) => s && !s.startsWith("{") && !s.startsWith(":"))
    .filter((s) => !/^(api|v\d+(\.\d+)?|rest|public|internal)$/i.test(s));
  return (segs[0] ?? "root").toLowerCase();
}

export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us)$/i.test(word)) return word;
  if (/(ches|shes|xes|zes|sses)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Deep-clone a JSON schema, replacing unresolved `$ref` nodes (tool schemas must be self-contained). */
export function sanitizeSchema(schema: unknown, depth = 0): JSONSchema {
  if (!isPlainObject(schema) || depth > 12) return {};
  const out: JSONSchema = {};
  if (typeof schema.$ref === "string") {
    const refName = schema.$ref.split("/").pop();
    return {
      type: "object",
      description: [schema.description, refName ? `(${refName} object)` : undefined].filter(Boolean).join(" "),
    };
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k === "properties" && isPlainObject(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv, depth + 1)]));
    } else if (k === "items") {
      out.items = sanitizeSchema(v, depth + 1);
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
      out[k] = v.map((x) => sanitizeSchema(x, depth + 1));
    } else if (k === "additionalProperties" && isPlainObject(v)) {
      out.additionalProperties = sanitizeSchema(v, depth + 1);
    } else if (k === "nullable" || k === "xml" || k === "externalDocs" || k === "discriminator" || k.startsWith("x-")) {
      // OpenAPI-only keywords; not JSON Schema.
    } else {
      out[k] = structuredCloneSafe(v);
    }
  }
  return out;
}

function structuredCloneSafe<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
