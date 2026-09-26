/**
 * Rendering helpers for the TypeScript target. Every spec-provided string that
 * lands in generated code goes through one of these so the output is always
 * syntactically valid, whatever the spec contains.
 */

/** A string literal for generated code (double-quoted, fully escaped). */
export function str(value: string): string {
  return JSON.stringify(value);
}

/** Escape text for use inside a generated template literal (`...`). */
export function templateBody(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
    .replace(/\r/g, "\\r");
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a JSON-compatible value as a TypeScript expression: unquoted keys when
 * they are valid identifiers, small scalar arrays inline, otherwise one entry
 * per line. `undefined` object fields are dropped (like JSON.stringify).
 */
export function tsLiteral(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => tsLiteral(v === undefined ? null : v, indent + 1));
    const oneLine = `[${items.join(", ")}]`;
    if (value.every((v) => v === null || typeof v !== "object") && oneLine.length + pad.length <= 100) return oneLine;
    return `[\n${items.map((i) => `${inner}${i},`).join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && typeof v !== "function",
    );
    if (entries.length === 0) return "{}";
    const flat = entries.every(([, v]) => isScalar(v) || (Array.isArray(v) && v.every(isScalar)));
    if (flat) {
      const oneLine = `{ ${entries.map(([k, v]) => `${key(k)}: ${tsLiteral(v, indent + 1)}`).join(", ")} }`;
      if (!oneLine.includes("\n") && pad.length + oneLine.length <= 80) return oneLine;
    }
    const lines = entries.map(([k, v]) => `${inner}${key(k)}: ${tsLiteral(v, indent + 1)},`);
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return "null";
}

function key(k: string): string {
  return IDENT.test(k) ? k : str(k);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "tool";
}

/** Make `name` unique within `taken` by appending _2, _3, ... (and records it). */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) {
    const suffix = `_${i}`;
    candidate = name.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(candidate);
  return candidate;
}

/** A valid npm package name derived from the spec name. */
export function packageName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[-]+$/g, "")
    .slice(0, 214);
  return cleaned.length > 0 ? cleaned : "agent-harness";
}

/** Single-line text safe for a Markdown table cell. */
export function mdCell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}

/** Collapse whitespace (including newlines) to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Indent every non-empty line of `text` by `spaces`. */
export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}
