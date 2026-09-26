/** Small helpers shared by the heuristic and LLM planners. */
import type { ApiEndpoint, JSONSchema, ProjectProfile } from "../core/types.js";

export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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

export function titleCase(s: string): string {
  return kebab(s)
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Env-var prefix for the project, e.g. "acme-orders" -> "ACME_ORDERS". */
export function envPrefix(profile: ProjectProfile): string {
  const p = snake(kebab(profile.name)).toUpperCase();
  return /^[A-Z]/.test(p) ? p : `APP_${p}`;
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
  let p = path.trim().split("?")[0]!;
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
