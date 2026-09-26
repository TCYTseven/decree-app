import type { JSONSchema } from "./types.js";

/**
 * Keywords whose value is a map from user-chosen names to subschemas. The map's keys are property / definition
 * names, not keywords, so a property called `x-request-id` must survive stripping.
 */
const NAMED_SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is instance data (or a list of names), never a schema: copied verbatim. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "example", "required", "dependentRequired"]);

/** True for a decree-private schema keyword (`x-allow-flags`, `x-json-string`, ...). */
export function isPrivateKeyword(key: string): boolean {
  return key.startsWith("x-");
}

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivateKeyword(k)) continue;
    if (DATA_KEYWORDS.has(k)) out[k] = v;
    else if (NAMED_SCHEMA_MAPS.has(k) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, stripValue(sub)]));
    } else out[k] = stripValue(v);
  }
  return out;
}

/**
 * Copy of `schema` without decree-private keywords (any key starting with `x-`, at any depth), for sending to the
 * Anthropic API. Property names, definition names and instance data (`enum`, `const`, `default`, `examples`,
 * `required`) are left untouched. The input is not modified.
 */
export function stripPrivateKeywords<T extends JSONSchema | undefined>(schema: T): T {
  return (schema === undefined ? undefined : stripValue(schema)) as T;
}
