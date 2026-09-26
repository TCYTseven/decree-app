import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal dotenv parser. Supports `KEY=value`, `export KEY=value`, `#` comment lines, inline
 * ` # comments` after unquoted values, single quotes (literal), double quotes (with \n \r \t \" \\
 * escapes, may span lines), and backtick quotes. Later keys win.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ") || line.startsWith("export\t")) line = line.slice(7).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let raw = m[2]!;
    const q = raw[0];
    if (q === '"' || q === "'" || q === "`") {
      // Find closing quote, possibly on a later line (multiline values).
      let body = raw.slice(1);
      let close = findClosingQuote(body, q);
      while (close === -1 && i + 1 < lines.length) {
        i++;
        body += "\n" + lines[i]!;
        close = findClosingQuote(body, q);
      }
      let value = close === -1 ? body : body.slice(0, close);
      if (q === '"') {
        value = value.replace(/\\([nrt"\\])/g, (_, c: string) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
        );
      }
      out[key] = value;
    } else {
      const hash = raw.search(/\s#/);
      if (hash !== -1) raw = raw.slice(0, hash);
      out[key] = raw.trim();
    }
  }
  return out;
}

function findClosingQuote(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && q === '"') {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/** Read `.env.local` then `.env` in `dir` and return the first non-empty value for `key`. */
export function readDotenvValue(key: string, dir: string = process.cwd()): string | undefined {
  for (const file of [".env.local", ".env"]) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const v = parseDotenv(content)[key];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}
