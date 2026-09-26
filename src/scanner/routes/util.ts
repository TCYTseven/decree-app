import path from "node:path";
import type { ApiEndpoint, ApiParam, JSONSchema } from "../../core/types.js";

export type Method = ApiEndpoint["method"];
export const HTTP_METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface RouteHit {
  method: Method;
  /** Normalized path using {param} syntax. */
  path: string;
  file: string;
  line: number;
  operationId?: string;
  summary?: string;
  /** Extra (non-path) params, e.g. query params from a FastAPI signature. */
  params?: ApiParam[];
  /** Schemas for path params, keyed by name (defaults to string). */
  pathTypes?: Record<string, JSONSchema>;
  requestBody?: JSONSchema;
}

export function toMethod(m: string): Method | undefined {
  const u = m.toUpperCase();
  if (u === "DEL") return "DELETE";
  return (HTTP_METHODS as string[]).includes(u) ? (u as Method) : undefined;
}

const TYPE_HINTS: Record<string, JSONSchema> = {
  int: { type: "integer" },
  integer: { type: "integer" },
  float: { type: "number" },
  number: { type: "number" },
  uuid: { type: "string", format: "uuid" },
  slug: { type: "string" },
  path: { type: "string" },
  str: { type: "string" },
  string: { type: "string" },
};

/**
 * Convert framework route syntax to OpenAPI braces:
 *   :id, :id?, :id(\\d+)   (express/koa/gin/echo/fiber/rails)
 *   <id>, <int:id>          (flask/django)
 *   [id], [...slug], [[...slug]]   (next.js)
 *   {id:[0-9]+}, {id...}, {id?}    (gorilla mux, go 1.22, laravel)
 *   (?P<id>\d+)             (django re_path)
 *   *filepath, *            (gin / express wildcard)
 */
export function normalizePath(raw: string, opts: { keepTrailingSlash?: boolean } = {}): { path: string; types: Record<string, JSONSchema> } {
  const types: Record<string, JSONSchema> = {};
  let p = raw.trim();
  // Go 1.22 "GET /x" patterns are handled by the caller; strip host if any.
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, "");
  // django regex paths
  if (/\(\?P</.test(p) || p.startsWith("^")) {
    p = p.replace(/^\^/, "").replace(/\$$/, "");
    p = p.replace(/\(\?P<(\w+)>([^)]*)\)/g, (_, n: string, re: string) => {
      if (/^\\d\+?$|^\[0-9\]\+?$/.test(re)) types[n] = { type: "integer" };
      return `{${n}}`;
    });
    p = p.replace(/\\\//g, "/").replace(/\\\./g, ".");
  }
  // hono regex params  :id{[0-9]+}  -> :id  (before brace handling turns the regex into a bogus param)
  p = p.replace(/:(\w+)\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, n: string, re: string) => {
    if (/^(\\d|\[0-9\])\+?$/.test(re)) types[n] = { type: "integer" };
    return `:${n}`;
  });
  // axum 0.8 / matchit catch-all  {*rest}
  p = p.replace(/\{\*(\w+)\}/g, "{$1}");
  // flask / django converters
  p = p.replace(/<(?:(\w+):)?(\w+)>/g, (_, conv: string | undefined, n: string) => {
    if (conv && TYPE_HINTS[conv] && conv !== "str" && conv !== "string") types[n] = TYPE_HINTS[conv]!;
    return `{${n}}`;
  });
  // next.js dynamic segments
  p = p.replace(/\[\[\.\.\.(\w+)\]\]|\[\.\.\.(\w+)\]|\[(\w+)\]/g, (_, a?: string, b?: string, c?: string) => `{${a ?? b ?? c}}`);
  // brace params with regex / wildcard / optional suffixes; fastapi {p:path}
  p = p.replace(/\{(\w+)(?::[^}]*)?(?:\.\.\.)?\??\}/g, (_, n: string) => `{${n}}`);
  // express/gin style params (with optional regex / optional marker)
  p = p.replace(/(^|[\/\-.]):(\w+)(\([^)]*\))?\??/g, (_, lead: string, n: string, re?: string) => {
    if (re && /\\d|\[0-9\]/.test(re)) types[n] = { type: "integer" };
    return `${lead}{${n}}`;
  });
  p = p.replace(/\{\$\}/g, "");
  // wildcards
  p = p.replace(/\*(\w+)/g, (_, n: string) => `{${n}}`);
  p = p.replace(/(^|\/)\*(?=\/|$)/g, "$1{wildcard}");
  p = p.replace(/\(\.\*\)/g, "{wildcard}");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (!opts.keepTrailingSlash && p.length > 1) p = p.replace(/\/+$/, "");
  return { path: p || "/", types };
}

/** Join a mount prefix and a route path. */
export function joinPath(prefix: string, p: string, keepTrailingSlash = false): string {
  const pre = prefix.replace(/\/+$/, "");
  if (!pre) return p || "/";
  if (p === "") return pre;
  if (p === "/") return keepTrailingSlash ? pre + "/" : pre;
  const joined = (pre + (p.startsWith("/") ? p : "/" + p)).replace(/\/{2,}/g, "/");
  return keepTrailingSlash ? joined : joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

export function pathParamNames(p: string): string[] {
  return [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/**
 * Bracket scanning is linear per call, so a file with thousands of unclosed openers (minified or generated code,
 * or a truncated file) would make detectors quadratic. Each text gets a budget of scanned characters; once it is
 * spent, matching fails (-1) and detectors skip the construct instead of hanging the scan.
 */
const SCAN_BUDGET = 40_000_000;
let budgetText: string | undefined;
let budgetLeft = SCAN_BUDGET;

/** Charge `n` scanned characters to `text`'s budget; false once the budget is exhausted. */
export function chargeScan(text: string, n: number): boolean {
  if (text !== budgetText) {
    budgetText = text;
    budgetLeft = SCAN_BUDGET;
  }
  budgetLeft -= n;
  return budgetLeft >= 0;
}

/** Index of the bracket that closes the one at `openIdx` (supports () [] {}), skipping strings. */
export function matchBracket(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return -1;
  const r = matchBracketRaw(text, openIdx, close);
  return chargeScan(text, (r < 0 ? text.length : r) - openIdx + 1) ? r : -1;
}

function matchBracketRaw(text: string, openIdx: number, close: string): number {
  if (budgetText === text && budgetLeft < 0) return -1;
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

/** Split on top-level commas (ignores commas nested in brackets/strings). */
export function splitTopLevel(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += s[++i] ?? "";
      } else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    if (c === ")" || c === "]" || c === "}" || (c === ">" && s[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Resolve a relative JS/TS import specifier to a known source file. */
export function resolveJsImport(fromFile: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const stripped = base.replace(/\.(m|c)?js$/, "");
  const exts = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".mts"];
  const candidates = [base, ...exts.map((e) => stripped + e), ...exts.map((e) => `${stripped}/index${e}`)];
  return candidates.find((c) => known.has(c));
}

/** Map a Python type annotation to a JSON schema (best effort). */
export function pyTypeToSchema(t: string | undefined, models?: Map<string, JSONSchema>, depth = 0): { schema: JSONSchema; optional: boolean } {
  if (!t) return { schema: {}, optional: false };
  let s = t.trim().replace(/^["']|["']$/g, "");
  let optional = false;
  const annotated = /^Annotated\[(.*)\]$/s.exec(s);
  if (annotated) s = splitTopLevel(annotated[1]!)[0] ?? s;
  const opt = /^Optional\[(.*)\]$/s.exec(s);
  if (opt) {
    optional = true;
    s = opt[1]!;
  }
  const unionParts = splitTopLevel(s, "|");
  if (unionParts.length > 1) {
    const nonNone = unionParts.filter((x) => x !== "None");
    if (nonNone.length < unionParts.length) optional = true;
    s = nonNone[0] ?? "str";
  }
  const union = /^Union\[(.*)\]$/s.exec(s);
  if (union) {
    const parts = splitTopLevel(union[1]!).filter((x) => x !== "None");
    if (parts.length < splitTopLevel(union[1]!).length) optional = true;
    s = parts[0] ?? "str";
  }
  const base = s.replace(/^(typing|t|pydantic|datetime|uuid|decimal)\./, "");
  const lit = /^Literal\[(.*)\]$/s.exec(base);
  if (lit) {
    const values = splitTopLevel(lit[1]!).map((v) => v.replace(/^["']|["']$/g, ""));
    return { schema: { type: "string", enum: values }, optional };
  }
  const list = /^(?:list|List|Sequence|set|Set|tuple|Tuple)\[(.*)\]$/s.exec(base);
  if (list) return { schema: { type: "array", items: pyTypeToSchema(splitTopLevel(list[1]!)[0], models, depth + 1).schema }, optional };
  if (/^(dict|Dict|Mapping)\b/.test(base)) return { schema: { type: "object" }, optional };
  const simple: Record<string, JSONSchema> = {
    str: { type: "string" },
    int: { type: "integer" },
    float: { type: "number" },
    Decimal: { type: "number" },
    bool: { type: "boolean" },
    bytes: { type: "string" },
    EmailStr: { type: "string", format: "email" },
    HttpUrl: { type: "string", format: "uri" },
    AnyUrl: { type: "string", format: "uri" },
    UUID: { type: "string", format: "uuid" },
    UUID4: { type: "string", format: "uuid" },
    datetime: { type: "string", format: "date-time" },
    date: { type: "string", format: "date" },
    list: { type: "array" },
    List: { type: "array" },
    Any: {},
  };
  if (simple[base]) return { schema: { ...simple[base]! }, optional };
  if (models && depth < 4 && models.has(base)) return { schema: { ...models.get(base)! }, optional };
  return { schema: { type: "object", description: base }, optional };
}

/** Map a TypeScript type annotation to a JSON schema (best effort). */
export function tsTypeToSchema(t: string, models?: Map<string, JSONSchema>, depth = 0): JSONSchema {
  let s = t.trim();
  while (s.startsWith("(") && s.endsWith(")") && matchBracket(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  const parts = splitTopLevel(s, "|").filter((p) => p !== "null" && p !== "undefined");
  if (parts.length > 1 && parts.every((p) => /^['"].*['"]$/.test(p)))
    return { type: "string", enum: parts.map((p) => p.slice(1, -1)) };
  s = parts[0] ?? s;
  const arr = /^(.*)\[\]$/.exec(s) ?? /^Array<(.*)>$/.exec(s);
  if (arr) return { type: "array", items: tsTypeToSchema(arr[1]!, models, depth + 1) };
  switch (s) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "bigint":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "Date":
      return { type: "string", format: "date-time" };
    case "any":
    case "unknown":
      return {};
  }
  if (/^Record<|^\{/.test(s)) return { type: "object" };
  if (models && depth < 4 && models.has(s)) return { ...models.get(s)! };
  return { type: "object", description: s };
}

export function toEndpoint(hit: RouteHit): ApiEndpoint {
  const params: ApiParam[] = pathParamNames(hit.path).map((name) => ({
    name,
    in: "path" as const,
    required: true,
    schema: hit.pathTypes?.[name] ?? { type: "string" },
  }));
  for (const p of hit.params ?? []) if (!params.some((x) => x.name === p.name && x.in === p.in)) params.push(p);
  const ep: ApiEndpoint = { method: hit.method, path: hit.path, params, source: `${hit.file}:${hit.line}` };
  if (hit.summary) ep.summary = hit.summary;
  if (hit.operationId) ep.operationId = hit.operationId;
  if (hit.requestBody) ep.requestBody = hit.requestBody;
  return ep;
}
