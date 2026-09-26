import type { JSONSchema } from "../../core/types.js";

/** Serialize a value as a JS literal. JSON is valid JS; escape U+2028/9 for older parsers. */
export function lit(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const MAX_DEPTH = 8;

function isObj(v: unknown): v is JSONSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withDescription(src: string, schema: JSONSchema): string {
  return typeof schema.description === "string" && schema.description.length > 0
    ? `${src}.describe(${lit(schema.description)})`
    : src;
}

function enumSource(values: unknown[]): string {
  const uniq: unknown[] = [];
  for (const v of values) if (!uniq.some((u) => JSON.stringify(u) === JSON.stringify(v))) uniq.push(v);
  if (uniq.length > 0 && uniq.every((v) => typeof v === "string")) {
    return `z.enum([${uniq.map(lit).join(", ")}])`;
  }
  const lits = uniq
    .filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .map((v) => `z.literal(${lit(v)})`);
  if (lits.length === 0) return "z.any()";
  if (lits.length === 1) return lits[0]!;
  return `z.union([${lits.join(", ")}])`;
}

/** Zod source for a JSON schema, without description/optional wrappers. */
function baseSource(schema: JSONSchema, depth: number): string {
  if (depth > MAX_DEPTH) return "z.any()";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return enumSource(schema.enum);
  if ("const" in schema && schema.const !== undefined) return enumSource([schema.const]);

  const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null) as
    | unknown[]
    | null;
  if (variants) {
    const parts = variants.filter(isObj).map((v) => baseSource(v, depth + 1));
    if (parts.length === 0) return "z.any()";
    if (parts.length === 1) return parts[0]!;
    return `z.union([${parts.join(", ")}])`;
  }

  let types: string[] = [];
  if (typeof schema.type === "string") types = [schema.type];
  else if (Array.isArray(schema.type)) types = schema.type.filter((t): t is string => typeof t === "string");
  else if (isObj(schema.properties)) types = ["object"];
  else if (isObj(schema.items)) types = ["array"];

  const nullable = types.includes("null") && types.length > 1;
  const nonNull = nullable ? types.filter((t) => t !== "null") : types;
  const parts = nonNull.map((t) => typeSource(t, schema, depth));
  let src: string;
  if (parts.length === 0) src = "z.any()";
  else if (parts.length === 1) src = parts[0]!;
  else src = `z.union([${parts.join(", ")}])`;
  return nullable ? `${src}.nullable()` : src;
}

function typeSource(type: string, schema: JSONSchema, depth: number): string {
  switch (type) {
    case "string":
      return "z.string()";
    case "number":
      return "z.number()";
    case "integer":
      return "z.number().int()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return `z.array(${isObj(schema.items) ? propSource(schema.items, true, depth + 1) : "z.any()"})`;
    case "object":
      return objectSource(schema, depth);
    default:
      return "z.any()";
  }
}

function propSource(schema: JSONSchema, required: boolean, depth: number): string {
  const src = withDescription(baseSource(schema, depth), schema);
  return required ? src : `${src}.optional()`;
}

/** Entries of a z.object shape, one per line, for the given object schema. */
export function shapeEntries(schema: JSONSchema, depth = 0, indent = "  "): string[] {
  const props = isObj(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []);
  return Object.keys(props).map((key) => {
    const p = props[key];
    const src = isObj(p) ? propSource(p, required.has(key), depth + 1) : required.has(key) ? "z.any()" : "z.any().optional()";
    return `${indent}${lit(key)}: ${src},`;
  });
}

function objectSource(schema: JSONSchema, depth: number): string {
  const hasProps = isObj(schema.properties) && Object.keys(schema.properties).length > 0;
  const ap = schema.additionalProperties;
  if (!hasProps) {
    if (ap === false) return "z.object({}).strict()";
    return `z.record(z.string(), ${isObj(ap) ? baseSource(ap, depth + 1) : "z.any()"})`;
  }
  const entries = shapeEntries(schema, depth, "");
  let src = `z.object({ ${entries.join(" ")} })`;
  if (ap === true) src += ".catchall(z.any())";
  else if (isObj(ap)) src += `.catchall(${baseSource(ap, depth + 1)})`;
  else if (ap === false) src += ".strict()";
  return src;
}

/**
 * Zod source for a tool's top-level input schema. Always a `z.object(...)`, so
 * the MCP SDK advertises `type: "object"`. Unknown keys are stripped unless the
 * schema opts in with `additionalProperties`.
 */
export function toolInputZod(schema: JSONSchema, indent = "  "): string {
  const entries = shapeEntries(schema, 0, `${indent}  `);
  let src = entries.length > 0 ? `z.object({\n${entries.join("\n")}\n${indent}})` : "z.object({})";
  const ap = schema.additionalProperties;
  if (ap === true) src += ".catchall(z.any())";
  else if (isObj(ap)) src += `.catchall(${baseSource(ap, 1)})`;
  return withDescription(src, schema);
}
