import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { GENERATED_MARKER } from "../core/markers.js";

/** Directories that are never walked, regardless of .gitignore. */
export const ALWAYS_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".decree",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".terraform",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".vercel",
  ".idea",
  ".eggs",
  "bower_components",
  "jspm_packages",
  ".serverless",
  ".angular",
  ".expo",
  ".dart_tool",
]);

export interface FileEntry {
  /** POSIX path relative to the project root. */
  path: string;
  /** Base name. */
  name: string;
  /** Lower-cased extension including the dot ("" when none). */
  ext: string;
  size: number;
  /** Number of path segments above the file (0 = root). */
  depth: number;
}

export interface WalkResult {
  files: FileEntry[];
  /** POSIX paths of walked directories, relative to root (root itself excluded). */
  dirs: string[];
  truncated: boolean;
}

interface Matcher {
  base: string; // POSIX dir relative to root ("" for root)
  ig: Ignore;
}

async function loadIgnoreFile(abs: string): Promise<Ignore | null> {
  try {
    const text = await fs.readFile(abs, "utf8");
    if (!text.trim()) return null;
    return ignore().add(text);
  } catch {
    return null;
  }
}

function isIgnored(matchers: Matcher[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const m of matchers) {
    let sub: string;
    if (m.base === "") sub = rel;
    else if (rel.startsWith(m.base + "/")) sub = rel.slice(m.base.length + 1);
    else continue;
    if (!sub) continue;
    const r = m.ig.test(isDir ? sub + "/" : sub);
    if (r.ignored) ignored = true;
    else if (r.unignored) ignored = false;
  }
  return ignored;
}

/**
 * What decree itself generated here (from `.decree/manifest.json`): whole output directories below the root and
 * individual generated files. The scanner must not mistake the generated harness (its package.json, pyproject,
 * env vars, CLI) for the user's project on the next scan.
 */
async function loadGeneratedOutputs(root: string): Promise<{ dirs: Set<string>; files: Set<string> }> {
  const dirs = new Set<string>();
  const files = new Set<string>();
  try {
    const m = JSON.parse(await fs.readFile(path.join(root, ".decree", "manifest.json"), "utf8")) as {
      outputs?: Record<string, { files?: Record<string, string> }>;
    };
    for (const [key, out] of Object.entries(m.outputs ?? {})) {
      const dir = path.posix.normalize(key.replace(/\\/g, "/")).replace(/\/+$/, "");
      if (dir.startsWith("..") || path.posix.isAbsolute(dir)) continue;
      if (dir && dir !== ".") dirs.add(dir);
      for (const f of Object.keys(out?.files ?? {})) files.add(dir && dir !== "." ? `${dir}/${f}` : f);
    }
  } catch {
    // no manifest, or unreadable: nothing generated to skip
  }
  return { dirs, files };
}

/**
 * Breadth-first walk of `root`, honoring .gitignore files (root and nested),
 * .git/info/exclude and .decreeignore. Breadth-first so that when the file cap
 * is hit, the top-level structure (manifests, configs) is still captured.
 */
export async function walkProject(root: string, maxFiles: number): Promise<WalkResult> {
  const files: FileEntry[] = [];
  const dirs: string[] = [];
  let truncated = false;

  const generated = await loadGeneratedOutputs(root);
  const rootMatchers: Matcher[] = [];
  for (const f of [".gitignore", ".git/info/exclude", ".decreeignore"]) {
    const ig = await loadIgnoreFile(path.join(root, f));
    if (ig) rootMatchers.push({ base: "", ig });
  }

  type Listed = {
    rel: string;
    files: FileEntry[];
    subdirs: { rel: string; matchers: Matcher[] }[];
  };
  const listDir = async (rel: string, inherited: Matcher[]): Promise<Listed> => {
    const abs = rel ? path.join(root, rel) : root;
    const out: Listed = { rel, files: [], subdirs: [] };
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return out;
    }
    let matchers = inherited;
    if (rel && entries.some((e) => e.name === ".gitignore" && e.isFile())) {
      const ig = await loadIgnoreFile(path.join(abs, ".gitignore"));
      if (ig) matchers = [...inherited, { base: rel, ig }];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const fileEntries: { name: string; childRel: string }[] = [];
    const subdirs: string[] = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info") || generated.dirs.has(childRel)) continue;
        if (isIgnored(matchers, childRel, true)) continue;
        subdirs.push(childRel);
      } else if (e.isFile()) {
        if (generated.files.has(childRel) || isIgnored(matchers, childRel, false)) continue;
        fileEntries.push({ name: e.name, childRel });
      }
      // symlinks and special files are skipped (avoids cycles)
    }
    // A directory holding the .decree-generated marker is decree's own output (even without a manifest): skip it.
    const marked = await Promise.all(subdirs.map((d) => fs.access(path.join(root, d, GENERATED_MARKER)).then(() => true, () => false)));
    subdirs.forEach((d, i) => {
      if (!marked[i]) out.subdirs.push({ rel: d, matchers });
    });
    const depth = rel ? rel.split("/").length : 0;
    const stats = await Promise.all(fileEntries.map((f) => fs.stat(path.join(root, f.childRel)).catch(() => null)));
    fileEntries.forEach((f, i) => {
      const st = stats[i];
      if (!st) return;
      const dot = f.name.lastIndexOf(".");
      out.files.push({ path: f.childRel, name: f.name, ext: dot > 0 ? f.name.slice(dot).toLowerCase() : "", size: st.size, depth });
    });
    return out;
  };

  let queue: { rel: string; matchers: Matcher[] }[] = [{ rel: "", matchers: rootMatchers }];
  const BATCH = 32;
  outer: while (queue.length) {
    const next: typeof queue = [];
    for (let b = 0; b < queue.length; b += BATCH) {
      const listed = await Promise.all(queue.slice(b, b + BATCH).map((q) => listDir(q.rel, q.matchers)));
      // Consume in deterministic (sorted, breadth-first) order.
      for (const l of listed) {
        for (const sd of l.subdirs) {
          dirs.push(sd.rel);
          next.push(sd);
        }
        for (const f of l.files) {
          if (files.length >= maxFiles) {
            truncated = true;
            break outer;
          }
          files.push(f);
        }
      }
    }
    queue = next;
  }

  if (truncated) {
    // Directories discovered but never listed are still real; keep them only if they hold walked files.
    const withFiles = new Set<string>();
    for (const f of files) {
      let d = path.posix.dirname(f.path);
      while (d && d !== "." && !withFiles.has(d)) {
        withFiles.add(d);
        d = path.posix.dirname(d);
      }
    }
    const kept = dirs.filter((d) => withFiles.has(d));
    dirs.length = 0;
    dirs.push(...kept);
  }

  return { files, dirs, truncated };
}
