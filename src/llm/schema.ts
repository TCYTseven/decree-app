/**
 * JSON Schema helpers for Anthropic structured outputs (`output_config.format`).
 *
 * Structured outputs accept a subset of JSON Schema:
 *   - types object/array/string/integer/number/boolean/null, enum, const, anyOf, allOf, $ref/$defs
 *   - string formats: date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid
 *   - every object MUST have `additionalProperties: false`
 *   - NOT supported: recursive schemas, numeric constraints (minimum/maximum/multipleOf),
 *     string constraints (minLength/maxLength/pattern), complex array constraints.
 *
 * ## The `x-json-string` escape hatch
 *
 * Structured outputs cannot express "any object" (a free-form JSON value), because every object must
 * be closed with `additionalProperties: false`. HarnessSpec's `tools[].inputSchema` is exactly that: a
 * free-form JSON Schema. So:
 *
 *   - Mark a field with `"x-json-string": true` in the schema you pass to `llm.generateJSON`.
 *   - `toStrictSchema` sends it as `{ type: "string" }` (the model writes JSON text).
 *   - After the response, `decodeJsonStrings` JSON.parses those fields back into values.
 *
 * Free-form objects (`type: "object"` with no `properties`, or `additionalProperties` true/schema)
 * are treated as `x-json-string` automatically. Use `jsonStringField(description)` to build one.
 */
import type { JSONSchema } from "../core/types.js";

export const JSON_STRING_KEY = "x-json-string";

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords that pass through unchanged (their children are converted separately). */
const PASSTHROUGH = new Set(["type", "description", "title", "enum", "const"]);

/** Build a schema for a field the model should write as JSON text (decoded after the response). */
export function jsonStringField(description?: string): JSONSchema {
  return { type: "object", [JSON_STRING_KEY]: true, ...(description ? { description } : {}) };
}

function typeIncludes(schema: JSONSchema, t: string): boolean {
  const ty = schema.type;
  return ty === t || (Array.isArray(ty) && ty.includes(t));
}

function isObjectSchema(schema: JSONSchema): boolean {
  return typeIncludes(schema, "object") || (schema.type === undefined && isPlainObject(schema.properties));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when a field is sent to the model as JSON text: explicit `x-json-string: true`, or a free-form
 * object (no `properties`, or open `additionalProperties`).
 */
export function isJsonStringSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  const s = schema as JSONSchema;
  if (s[JSON_STRING_KEY] === true) return true;
  if (s.$ref !== undefined || s.anyOf !== undefined || s.allOf !== undefined || s.oneOf !== undefined) return false;
  if (!isObjectSchema(s)) return false;
  const props = s.properties;
  const hasProps = isPlainObject(props) && Object.keys(props).length > 0;
  const ap = s.additionalProperties;
  const openAdditional = ap === true || isPlainObject(ap);
  if (!hasProps) return ap !== false; // no declared properties: free-form unless explicitly closed (= `{}`)
  return openAdditional;
}

function jsonStringDescription(original?: unknown): string {
  const base = typeof original === "string" && original.trim() ? original.trim() + " " : "";
  return `${base}(Write this value as a JSON-encoded string, e.g. "{\\"type\\":\\"object\\"}".)`;
}

/**
 * Convert an arbitrary JSON Schema into one accepted by structured outputs:
 * closes every object (`additionalProperties: false`), filters `required` to declared properties,
 * maps `oneOf` -> `anyOf`, drops unsupported keywords and formats, and turns `x-json-string` /
 * free-form object fields into `type: "string"`. Pure: never mutates the input.
 */
export function toStrictSchema(schema: JSONSchema): JSONSchema {
  return convert(schema, true);
}

function convert(schema: unknown, isRoot = false): JSONSchema {
  if (!isPlainObject(schema)) return {};
  const s = schema as JSONSchema;

  if (!isRoot && isJsonStringSchema(s)) {
    return { type: "string", description: jsonStringDescription(s.description) };
  }

  const out: JSONSchema = {};
  for (const [k, v] of Object.entries(s)) {
    if (PASSTHROUGH.has(k)) {
      if (k === "type" && Array.isArray(v) && v.length === 1) out.type = v[0] as string;
      else out[k] = v;
    }
  }

  if (typeof s.format === "string" && SUPPORTED_FORMATS.has(s.format)) out.format = s.format;
  if (typeof s.$ref === "string") out.$ref = s.$ref;

  for (const defsKey of ["$defs", "definitions"] as const) {
    const defs = s[defsKey];
    if (isPlainObject(defs)) {
      out[defsKey] = Object.fromEntries(Object.entries(defs).map(([name, d]) => [name, convert(d)]));
    }
  }

  const variants = (s.anyOf ?? s.oneOf) as unknown;
  if (Array.isArray(variants)) out.anyOf = variants.map((v) => convert(v));
  if (Array.isArray(s.allOf)) out.allOf = (s.allOf as unknown[]).map((v) => convert(v));

  if (s.items !== undefined) {
    if (Array.isArray(s.items)) {
      // Tuple form is unsupported; approximate with anyOf over the members.
      out.items = s.items.length ? { anyOf: (s.items as unknown[]).map((v) => convert(v)) } : {};
    } else {
      out.items = convert(s.items);
    }
  }

  if (isObjectSchema(s) || isPlainObject(s.properties)) {
    const props = isPlainObject(s.properties) ? s.properties : {};
    out.properties = Object.fromEntries(Object.entries(props).map(([name, p]) => [name, convert(p)]));
    if (out.type === undefined) out.type = "object";
    const req = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string" && r in props) : [];
    out.required = [...new Set(req)];
    out.additionalProperties = false;
  }

  // Enum/const with no type is fine as-is; bare `{}` (any value) is rare and is left alone.
  return out;
}

/**
 * Walk `value` alongside the ORIGINAL (non-strict) schema and JSON.parse every string found at an
 * `x-json-string` / free-form-object position. Values that are already non-strings are left as-is,
 * so this is safe on output from the plain-text fallback as well. Throws on invalid JSON text so the
 * caller can retry.
 */
export function decodeJsonStrings<T = unknown>(value: unknown, schema: JSONSchema, root: JSONSchema = schema, path = "$"): T {
  return decode(value, schema, root, path, 0) as T;
}

function resolveRef(ref: string, root: JSONSchema): JSONSchema | undefined {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const defs = root[m[1]!];
  if (!isPlainObject(defs)) return undefined;
  const d = defs[decodeURIComponent(m[2]!.replace(/~1/g, "/").replace(/~0/g, "~"))];
  return isPlainObject(d) ? (d as JSONSchema) : undefined;
}

function decode(value: unknown, schema: unknown, root: JSONSchema, path: string, depth: number): unknown {
  if (!isPlainObject(schema) || depth > 64) return value;
  let s = schema as JSONSchema;
  if (typeof s.$ref === "string") {
    const r = resolveRef(s.$ref, root);
    if (r) s = r;
  }

  if (depth > 0 && isJsonStringSchema(s)) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`${path}: expected JSON-encoded text but could not parse it (${(e as Error).message})`);
    }
  }

  if (Array.isArray(value)) {
    const items = s.items;
    if (isPlainObject(items)) return value.map((v, i) => decode(v, items, root, `${path}[${i}]`, depth + 1));
    return value;
  }

  if (isPlainObject(value)) {
    let out: Record<string, unknown> = { ...value };
    const props = s.properties;
    if (isPlainObject(props)) {
      for (const [k, sub] of Object.entries(props)) {
        if (k in out) out[k] = decode(out[k], sub, root, `${path}.${k}`, depth + 1);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = s[key];
      if (!Array.isArray(variants)) continue;
      for (const v of variants) {
        if (isPlainObject(v) && (isPlainObject(v.properties) || typeof v.$ref === "string")) {
          out = decode(out, v, root, path, depth + 1) as Record<string, unknown>;
        }
      }
    }
    return out;
  }
  return value;
}

/**
 * Pull the first JSON value (object or array) out of free-form model text. Handles ```json fences,
 * leading prose, and trailing commentary. Returns `undefined` when nothing parses.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  // 1. Whole text.
  const whole = tryParse(trimmed);
  if (whole.ok) return whole.value;

  // 2. Fenced blocks (```json ... ``` or ``` ... ```), in order.
  const fence = /```[ \t]*([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
  for (let m; (m = fence.exec(text)); ) {
    const body = m[2]!.trim();
    const r = tryParse(body);
    if (r.ok) return r.value;
    const inner = scanBalanced(body);
    if (inner !== undefined) return inner;
  }

  // 3. First balanced {...} or [...] in the text.
  return scanBalanced(text);
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  if (!s) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Scan for balanced JSON objects/arrays, string-aware, trying each opening brace in order. */
function scanBalanced(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const c = text[start];
    if (c !== "{" && c !== "[") continue;
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    const r = tryParse(text.slice(start, end + 1));
    if (r.ok && typeof r.value === "object" && r.value !== null) return r.value;
  }
  return undefined;
}

function findBalancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Schema as shown to the model in prompt-only fallback mode: `x-json-string` markers are removed
 * (the model writes the real JSON value inline there).
 */
export function schemaForPrompt(schema: JSONSchema): JSONSchema {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== JSON_STRING_KEY) out[k] = strip(x);
    return out;
  };
  return strip(schema) as JSONSchema;
}
