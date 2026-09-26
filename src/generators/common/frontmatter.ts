import YAML from "yaml";

/**
 * Serialize an object as a YAML frontmatter block (`---\n...\n---\n`).
 * Keys whose value is `undefined` are dropped; key order is preserved, so the
 * output is deterministic for a given input.
 */
export function yamlFrontmatter(data: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v;
  const body = YAML.stringify(clean, { lineWidth: 0, minContentWidth: 0 });
  return `---\n${body.endsWith("\n") ? body : `${body}\n`}---\n`;
}

/** A markdown document with YAML frontmatter followed by `body`. Always ends with one newline. */
export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  return `${yamlFrontmatter(data)}\n${body.replace(/\s+$/, "")}\n`;
}

/** Split a document into its frontmatter data and body. Returns `data: null` when there is none. */
export function parseFrontmatter(doc: string): { data: Record<string, unknown> | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(doc);
  if (!m) return { data: null, body: doc };
  const data = YAML.parse(m[1]!) as Record<string, unknown> | null;
  return { data: data ?? {}, body: doc.slice(m[0].length).replace(/^\n/, "") };
}
