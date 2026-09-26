/**
 * Helpers for emitting Python (and TOML / Markdown / dotenv) source safely.
 *
 * Every string that originates from a HarnessSpec is untrusted: it may contain
 * quotes, backslashes, triple quotes, newlines, control characters or unicode
 * line separators. It only ever reaches generated source through these helpers.
 */

// Characters that are escaped even though JSON.stringify would leave them raw:
// DEL and C1 controls, soft hyphen, invisible formatting / bidi controls, the
// unicode line/paragraph separators, BOM, and specials. Keeps generated source
// readable in editors and immune to "trojan source" tricks.
const INVISIBLE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff0-\uffff]/g;

function escapeInvisible(json: string): string {
  return json.replace(INVISIBLE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * A Python string literal for `s`. JSON string syntax is a subset of Python's
 * (non-raw) string literal syntax: `\" \\ \/ \b \f \n \r \t \uXXXX` all mean the
 * same thing, and lone surrogates come out as `\udXXX` escapes.
 */
export function pyStr(s: string): string {
  return escapeInvisible(JSON.stringify(toScalar(s)));
}

/**
 * Replace lone UTF-16 surrogates with U+FFFD. A Python str holding one cannot be
 * printed, UTF-8 encoded or sent to the API, so it is never worth preserving.
 */
export function toScalar(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * A Python expression for a (possibly long, multi-line) string, written as
 * parenthesized implicit concatenation of one literal per line so it stays
 * readable in the generated file. `indent` is the indentation of the lines.
 */
export function pyText(s: string, indent = "    "): string {
  if (!s.includes("\n") && s.length <= 80) return pyStr(s);
  const lines = s.split(/(?<=\n)/); // keep the "\n" on each line
  const parts: string[] = [];
  for (const line of lines) {
    // Long lines are split further (on word boundaries) purely for readability.
    for (const chunk of chunkLine(line, 88)) parts.push(indent + pyStr(chunk));
  }
  const outer = indent.slice(4);
  return "(\n" + parts.join("\n") + "\n" + outer + ")";
}

function chunkLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    else cut += 1; // keep the space on the first chunk
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut += 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** A Python literal (dict/list/str/number/bool/None) for a JSON-like value, pretty-printed. */
export function pyLiteral(value: unknown, indent = "", step = "    "): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return 'float("nan")';
    if (!Number.isFinite(value)) return value > 0 ? 'float("inf")' : '-float("inf")';
    if (Object.is(value, -0)) return "0";
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return pyStr(value);
  const inner = indent + step;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      const inline = "[" + value.map((v) => pyLiteral(v)).join(", ") + "]";
      if (inline.length + indent.length <= 72 && !inline.includes("\n")) return inline;
    }
    const items = value.map((v) => inner + pyLiteral(v, inner, step) + ",");
    return "[\n" + items.join("\n") + "\n" + indent + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const items = entries.map(([k, v]) => inner + pyStr(k) + ": " + pyLiteral(v, inner, step) + ",");
    return "{\n" + items.join("\n") + "\n" + indent + "}";
  }
  return pyStr(String(value));
}

/** A tuple literal of strings, on one line when short. */
export function pyStrTuple(values: readonly string[], indent = ""): string {
  if (values.length === 0) return "()";
  const oneLine = "(" + values.map(pyStr).join(", ") + (values.length === 1 ? ",)" : ")");
  if (oneLine.length + indent.length <= 88) return oneLine;
  return "(\n" + values.map((v) => indent + "    " + pyStr(v) + ",").join("\n") + "\n" + indent + ")";
}

/** A TOML basic string (TOML shares JSON's escapes). */
export function tomlStr(s: string): string {
  return escapeInvisible(JSON.stringify(toScalar(s)));
}

/** Single-line, comment/docstring-safe text: printable, no quotes or backslashes. */
export function plain(s: string, max = 200): string {
  const flat = s
    .replace(/[\r\n\t]+/g, " ")
    .replace(INVISIBLE, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"'`\\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "..." : flat;
}

/** Text for a Markdown table cell. */
export function mdCell(s: string): string {
  return toScalar(s)
    .replace(INVISIBLE, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .trim();
}

/** A value for a .env file line (double-quoted when needed). */
export function envValue(s: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
}

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case", "type",
]);

// Top-level names that would shadow something the harness itself imports.
const RESERVED_MODULES = new Set([
  "anthropic", "httpx", "httpx2", "pytest", "test", "tests", "json", "os", "sys", "re", "io", "http", "shlex",
  "signal", "subprocess", "pathlib", "typing", "types", "tools", "agent", "config", "logging", "argparse",
  "dataclasses", "concurrent", "shutil", "time", "string", "random", "urllib", "email", "site",
]);

/** A valid, non-shadowing Python package name for a spec name. */
export function pythonPackageName(name: string): string {
  let pkg = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!pkg || /^[0-9]/.test(pkg) || PY_KEYWORDS.has(pkg) || RESERVED_MODULES.has(pkg)) pkg = "agent_" + pkg;
  return pkg.replace(/_+$/, "") || "agent";
}

/** A console-script / distribution name (PEP 508 friendly). */
export function scriptName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return s || "agent";
}

/** Environment-variable style prefix derived from the package name. */
export function envPrefix(pkg: string): string {
  return pkg.toUpperCase();
}
