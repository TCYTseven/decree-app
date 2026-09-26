/**
 * Minimal, forgiving TOML reader. Handles what manifests use in practice:
 * [tables], [[arrays of tables]], dotted keys, basic/literal/multiline strings,
 * numbers, booleans, (multiline) arrays and inline tables. Never throws; lines it
 * cannot parse are skipped.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string {
    return this.s[this.i] ?? "";
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  skipWs(newlines: boolean): void {
    while (!this.eof()) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) this.i++;
      else if (c === "#") {
        while (!this.eof() && this.peek() !== "\n") this.i++;
      } else break;
    }
  }
  skipLine(): void {
    while (!this.eof() && this.peek() !== "\n") this.i++;
    if (!this.eof()) this.i++;
  }
}

function parseKey(r: Reader): string[] {
  const parts: string[] = [];
  for (;;) {
    r.skipWs(false);
    const c = r.peek();
    if (c === '"' || c === "'") parts.push(parseString(r));
    else {
      const start = r.i;
      while (!r.eof() && /[A-Za-z0-9_\-]/.test(r.peek())) r.i++;
      if (r.i === start) throw new Error("bad key");
      parts.push(r.s.slice(start, r.i));
    }
    r.skipWs(false);
    if (r.peek() === ".") {
      r.i++;
      continue;
    }
    return parts;
  }
}

function parseString(r: Reader): string {
  const q = r.peek();
  const triple = r.s.startsWith(q.repeat(3), r.i);
  if (triple) {
    r.i += 3;
    if (r.peek() === "\n") r.i++;
    else if (r.s.startsWith("\r\n", r.i)) r.i += 2;
    const end = r.s.indexOf(q.repeat(3), r.i);
    if (end < 0) throw new Error("unterminated string");
    const raw = r.s.slice(r.i, end);
    r.i = end + 3;
    return q === '"' ? unescape(raw.replace(/\\\r?\n\s*/g, "")) : raw;
  }
  r.i++;
  let out = "";
  while (!r.eof()) {
    const c = r.peek();
    if (c === "\n") throw new Error("unterminated string");
    if (c === q) {
      r.i++;
      return q === '"' ? unescape(out) : out;
    }
    if (c === "\\" && q === '"') {
      out += c + (r.s[r.i + 1] ?? "");
      r.i += 2;
      continue;
    }
    out += c;
    r.i++;
  }
  throw new Error("unterminated string");
}

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "u":
      case "U": return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

function parseValue(r: Reader): TomlValue {
  r.skipWs(false);
  const c = r.peek();
  if (c === '"' || c === "'") return parseString(r);
  if (c === "[") {
    r.i++;
    const arr: TomlValue[] = [];
    for (;;) {
      r.skipWs(true);
      if (r.peek() === "]") {
        r.i++;
        return arr;
      }
      arr.push(parseValue(r));
      r.skipWs(true);
      if (r.peek() === ",") r.i++;
      else if (r.peek() === "]") {
        r.i++;
        return arr;
      } else throw new Error("bad array");
    }
  }
  if (c === "{") {
    r.i++;
    const tbl: TomlTable = {};
    for (;;) {
      r.skipWs(true);
      if (r.peek() === "}") {
        r.i++;
        return tbl;
      }
      const key = parseKey(r);
      r.skipWs(false);
      if (r.peek() !== "=") throw new Error("bad inline table");
      r.i++;
      setPath(tbl, key, parseValue(r));
      r.skipWs(true);
      if (r.peek() === ",") r.i++;
    }
  }
  const start = r.i;
  while (!r.eof() && !/[,\]\}\n#]/.test(r.peek())) r.i++;
  const raw = r.s.slice(start, r.i).trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw.replace(/_/g, ""));
  if (raw !== "" && !Number.isNaN(n)) return n;
  return raw; // dates and anything else stay as raw strings
}

function setPath(tbl: TomlTable, keys: string[], value: TomlValue): void {
  let t = tbl;
  for (let k = 0; k < keys.length - 1; k++) {
    const key = keys[k]!;
    const cur = t[key];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) t = cur;
    else {
      const n: TomlTable = {};
      t[key] = n;
      t = n;
    }
  }
  t[keys[keys.length - 1]!] = value;
}

function getTable(root: TomlTable, keys: string[], arrayOfTables: boolean): TomlTable {
  let t = root;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]!;
    const last = k === keys.length - 1;
    let cur = t[key];
    if (last && arrayOfTables) {
      if (!Array.isArray(cur)) t[key] = cur = [];
      const n: TomlTable = {};
      (cur as TomlValue[]).push(n);
      return n;
    }
    if (Array.isArray(cur)) {
      const lastEl = cur[cur.length - 1];
      if (lastEl && typeof lastEl === "object" && !Array.isArray(lastEl)) {
        t = lastEl;
        continue;
      }
    }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) t[key] = cur = {};
    t = cur as TomlTable;
  }
  return t;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const r = new Reader(text);
  while (!r.eof()) {
    r.skipWs(true);
    if (r.eof()) break;
    const lineStart = r.i;
    try {
      if (r.peek() === "[") {
        const aot = r.s.startsWith("[[", r.i);
        r.i += aot ? 2 : 1;
        const key = parseKey(r);
        r.i += aot ? 2 : 1;
        current = getTable(root, key, aot);
        r.skipLine();
        continue;
      }
      const key = parseKey(r);
      r.skipWs(false);
      if (r.peek() !== "=") throw new Error("expected =");
      r.i++;
      setPath(current, key, parseValue(r));
      r.skipLine();
    } catch {
      r.i = lineStart;
      r.skipLine();
    }
  }
  return root;
}

export function tget(t: TomlValue | undefined, ...keys: string[]): TomlValue | undefined {
  let cur: TomlValue | undefined = t;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function tstr(v: TomlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function ttable(v: TomlValue | undefined): TomlTable | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
