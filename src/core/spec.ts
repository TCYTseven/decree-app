import type { HarnessSpec } from "./types.js";

/** Validate + normalize a parsed decree.json. Fills defaults, dedupes tool names, fixes slugs. */
export function validateSpec(input: unknown): { ok: true; spec: HarnessSpec; warnings: string[] } | { ok: false; errors: string[] } {
  throw new Error("validateSpec: not implemented");
}

/** JSON Schema for decree.json (written to .decree/schema.json and referenced via $schema). */
export function specJsonSchema(): Record<string, unknown> {
  throw new Error("specJsonSchema: not implemented");
}
