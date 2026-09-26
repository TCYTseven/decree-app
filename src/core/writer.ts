import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GeneratedFile } from "./types.js";

export interface WriteOptions {
  /** Overwrite files the user edited since decree last wrote them. */
  force?: boolean;
  /** Compute the report without touching the disk. */
  dryRun?: boolean;
  /** Remove files decree generated previously that are no longer generated. */
  clean?: boolean;
  /** Where to persist hashes of what decree wrote (e.g. `.decree/manifest.json`). */
  manifestPath?: string;
}

export interface WriteReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Existing files that differ from what decree last wrote (user-modified); left alone. */
  skipped: string[];
  removed: string[];
}

export class WriterError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "WriterError";
    this.hint = hint;
  }
}

interface Manifest {
  version: 1;
  /** Keyed by output dir (relative to the manifest's project root, POSIX). */
  outputs: Record<string, { updatedAt: string; files: Record<string, string> }>;
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const toPosix = (p: string) => p.split(path.sep).join("/");

function manifestKey(manifestPath: string, outDir: string): string {
  // .decree/manifest.json -> project root is two levels up
  const root = path.dirname(path.dirname(path.resolve(manifestPath)));
  return toPosix(path.relative(root, outDir)) || ".";
}

async function readManifest(file: string | undefined): Promise<Manifest> {
  const empty: Manifest = { version: 1, outputs: {} };
  if (!file) return empty;
  try {
    const m = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Manifest>;
    return m && typeof m.outputs === "object" && m.outputs ? { version: 1, outputs: m.outputs } : empty;
  } catch {
    return empty;
  }
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) {
      if (st.isSymbolicLink()) throw new WriterError(`Refusing to write through symlink ${file}`);
      throw new WriterError(`Cannot write ${file}: a directory or special file is in the way`);
    }
    return await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a generated relative path and resolve it inside outDir. */
function resolveSafe(outDir: string, rel: string): string {
  if (!rel || rel.includes("\0")) throw new WriterError(`Refusing to write an empty or invalid path`);
  if (path.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new WriterError(`Refusing to write absolute path "${rel}" outside ${outDir}`);
  }
  const abs = path.resolve(outDir, rel);
  if (!isInside(outDir, abs) || abs === outDir) {
    throw new WriterError(`Refusing to write "${rel}": it resolves outside ${outDir}`);
  }
  return abs;
}

/** Walk up to the nearest existing ancestor and make sure its realpath is still inside outDir. */
async function assertRealInside(outDirReal: string, abs: string, outDir: string): Promise<void> {
  let cur = path.dirname(abs);
  while (isInside(outDir, cur)) {
    try {
      const real = await fs.realpath(cur);
      if (!isInside(outDirReal, real)) throw new WriterError(`Refusing to write ${abs}: ${cur} links outside ${outDir}`);
      return;
    } catch (err) {
      if (err instanceof WriterError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (cur === outDir) return;
    cur = path.dirname(cur);
  }
}

async function removeEmptyDirs(from: string, stopAt: string): Promise<void> {
  let cur = from;
  while (isInside(stopAt, cur) && cur !== stopAt) {
    try {
      await fs.rmdir(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/**
 * Write generated files into `outDir` without clobbering user edits.
 *
 * A file is only overwritten when its on-disk content still matches the hash
 * decree recorded the last time it wrote it (or with `force`).
 */
export async function writeFiles(outDir: string, files: GeneratedFile[], opts: WriteOptions = {}): Promise<WriteReport> {
  const root = path.resolve(outDir);
  const report: WriteReport = { created: [], updated: [], unchanged: [], skipped: [], removed: [] };
  const manifest = await readManifest(opts.manifestPath);
  const key = opts.manifestPath ? manifestKey(opts.manifestPath, root) : ".";
  const prev = manifest.outputs[key]?.files ?? {};
  const next: Record<string, string> = {};

  // Validate every path before touching the disk.
  const seen = new Set<string>();
  const planned = files.map((f) => {
    const abs = resolveSafe(root, f.path);
    const rel = toPosix(path.relative(root, abs));
    if (seen.has(rel)) throw new WriterError(`Generated file list contains "${rel}" twice`);
    seen.add(rel);
    return { file: f, abs, rel };
  });

  let rootReal = root;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    /* does not exist yet */
  }

  for (const { file, abs, rel } of planned) {
    await assertRealInside(rootReal, abs, root);
    const hash = sha256(file.content);
    const current = await readIfExists(abs);
    let write = false;
    if (current === undefined) {
      report.created.push(rel);
      write = true;
    } else if (sha256(current) === hash) {
      report.unchanged.push(rel);
    } else {
      const known = prev[rel];
      const userEdited = !known || known !== sha256(current);
      if (userEdited && !opts.force) {
        report.skipped.push(rel);
        if (known) next[rel] = known;
        continue;
      }
      report.updated.push(rel);
      write = true;
    }
    next[rel] = hash;
    if (opts.dryRun) continue;
    if (write) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, "utf8");
    }
    if (file.executable) {
      const st = await fs.stat(abs);
      if ((st.mode & 0o111) !== 0o111) await fs.chmod(abs, st.mode | 0o755);
    }
  }

  // Previously generated files that are no longer produced.
  for (const [rel, known] of Object.entries(prev)) {
    if (seen.has(rel)) continue;
    let abs: string;
    try {
      abs = resolveSafe(root, rel);
    } catch {
      continue; // ignore corrupt manifest entries
    }
    if (!opts.clean) {
      next[rel] = known; // remember it so a later --clean can remove it
      continue;
    }
    // Never delete through a directory symlink that leads outside outDir (the manifest may be stale or hand-edited).
    const linkedOut = await assertRealInside(rootReal, abs, root).then(
      () => false,
      () => true,
    );
    if (linkedOut) {
      report.skipped.push(rel);
      next[rel] = known;
      continue;
    }
    const current = await readIfExists(abs).catch(() => undefined);
    if (current === undefined) continue;
    if (sha256(current) !== known && !opts.force) {
      report.skipped.push(rel);
      next[rel] = known;
      continue;
    }
    report.removed.push(rel);
    if (!opts.dryRun) {
      await fs.rm(abs, { force: true });
      await removeEmptyDirs(path.dirname(abs), root);
    }
  }

  if (!opts.dryRun && opts.manifestPath) {
    manifest.outputs[key] = {
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))),
    };
    await fs.mkdir(path.dirname(opts.manifestPath), { recursive: true });
    await fs.writeFile(opts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  for (const list of Object.values(report)) (list as string[]).sort();
  return report;
}
