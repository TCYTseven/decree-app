import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileEntry, WalkResult } from "./walk.js";

/** Files larger than this are never read for content analysis. */
export const MAX_CONTENT_BYTES = 1024 * 1024;

export class ScanContext {
  readonly byPath = new Map<string, FileEntry>();
  private cache = new Map<string, Promise<string | null>>();

  constructor(
    readonly root: string,
    readonly walk: WalkResult,
  ) {
    for (const f of walk.files) this.byPath.set(f.path, f);
  }

  get files(): FileEntry[] {
    return this.walk.files;
  }

  has(rel: string): boolean {
    return this.byPath.has(rel);
  }

  /** First existing path among candidates (walked files only). */
  first(...rels: string[]): string | undefined {
    return rels.find((r) => this.byPath.has(r));
  }

  /**
   * Read a walked file as UTF-8. Returns null for missing, oversized (> maxBytes)
   * or binary files. Results are cached so each file is read at most once.
   */
  read(rel: string, maxBytes = MAX_CONTENT_BYTES): Promise<string | null> {
    const entry = this.byPath.get(rel);
    if (!entry || entry.size > maxBytes) return Promise.resolve(null);
    let p = this.cache.get(rel);
    if (!p) {
      p = fs
        .readFile(path.join(this.root, rel))
        .then((buf) => {
          const probe = buf.subarray(0, 8000);
          if (probe.includes(0)) return null;
          return buf.toString("utf8");
        })
        .catch(() => null);
      this.cache.set(rel, p);
    }
    return p;
  }

  /** Read only the first `bytes` of a walked file (no caching); null if binary/missing. */
  async head(rel: string, bytes = 4096): Promise<string | null> {
    const cached = this.cache.get(rel);
    if (cached) {
      const t = await cached;
      return t === null ? null : t.slice(0, bytes);
    }
    let fh: import("node:fs/promises").FileHandle | undefined;
    try {
      fh = await fs.open(path.join(this.root, rel), "r");
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      const slice = buf.subarray(0, bytesRead);
      if (slice.includes(0)) return null;
      return slice.toString("utf8");
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** Read many files with bounded concurrency. */
  async readMany(rels: string[], concurrency = 64): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let i = 0;
    const worker = async () => {
      while (i < rels.length) {
        const rel = rels[i++]!;
        const t = await this.read(rel);
        if (t !== null) out.set(rel, t);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rels.length) }, worker));
    return out;
  }
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Efficient line lookup for many offsets in the same text. */
export function lineIndex(text: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rb", ".php", ".java", ".kt", ".rs", ".cs", ".ex", ".exs", ".scala", ".swift",
]);

const TEST_PATH_RE =
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|cypress|playwright|fixtures?|testdata|examples?)\//i;
const TEST_FILE_RE = /(\.|_)(test|spec)\.[a-z]+$|^test_.*\.py$|_test\.go$|\.stories\.[a-z]+$/i;

const FIXTURE_PATH_RE = /(^|\/)(__tests__|__mocks__|tests?|fixtures?|testdata|examples?|samples?|e2e|cypress|playwright)\//i;

/** Paths holding test fixtures / examples: their manifests and specs describe other projects. */
export function isFixturePath(rel: string): boolean {
  return FIXTURE_PATH_RE.test(rel);
}

/**
 * Blank out comments (keeping offsets and line numbers intact) so commented-out
 * routes and doc examples are not detected. Only whole-line comments and block
 * comments are removed; trailing comments after code are left alone.
 */
export function stripComments(rel: string, text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  if (/\.(py|rb|ex|exs)$/.test(rel)) return text.replace(/^[ \t]*#.*$/gm, blank);
  let out = text.replace(/^[ \t]*\/\/.*$/gm, blank);
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m, offset: number) => {
    // Only treat as a comment when it starts a line or follows code punctuation, not inside a string like "src/**/*.ts".
    const before = out.slice(Math.max(0, offset - 1), offset);
    return before === "" || /[\s;{}(),=]/.test(before) ? blank(m) : m;
  });
  return out;
}

export function isTestPath(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(name);
}

/** Source files worth reading for route/env/model detection. */
export function isAnalyzableSource(f: FileEntry): boolean {
  if (!CODE_EXTS.has(f.ext)) return false;
  if (f.size > MAX_CONTENT_BYTES) return false;
  if (f.name.endsWith(".d.ts") || /\.min\.[cm]?js$/.test(f.name)) return false;
  if (isTestPath(f.path)) return false;
  return true;
}

export function basenameNoExt(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
