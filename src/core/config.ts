import { promises as fs } from "node:fs";
import path from "node:path";
import type { HarnessSpec, ProjectProfile } from "./types.js";
import { validateSpec, specJsonSchema } from "./spec.js";
import { CACHE_DIRNAME, DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { maskSecrets } from "./mask-secrets.js";

export const SCHEMA_REF = `./${CACHE_DIRNAME}/schema.json`;

export interface ProjectPaths {
  root: string;
  specPath: string;
  cacheDir: string;
  profilePath: string;
  manifestPath: string;
  schemaPath: string;
  runsDir: string;
  memoryDir: string;
  outDir: string;
}

/** Resolve the project root from `--cwd` and an optional positional dir. */
export function resolveProjectRoot(cwd?: string, dir?: string): string {
  const base = path.resolve(cwd ?? process.cwd());
  return dir ? path.resolve(base, dir) : base;
}

export function projectPaths(root: string, outDir: string = DEFAULT_OUT_DIR): ProjectPaths {
  const cacheDir = path.join(root, CACHE_DIRNAME);
  return {
    root,
    specPath: path.join(root, SPEC_FILENAME),
    cacheDir,
    profilePath: path.join(cacheDir, "profile.json"),
    manifestPath: path.join(cacheDir, "manifest.json"),
    schemaPath: path.join(cacheDir, "schema.json"),
    runsDir: path.join(cacheDir, "runs"),
    memoryDir: path.join(cacheDir, "memory"),
    outDir: path.resolve(root, outDir),
  };
}

export class SpecNotFoundError extends Error {
  hint: string;
  constructor(public file: string) {
    super(`No ${SPEC_FILENAME} found at ${file}`);
    this.name = "SpecNotFoundError";
    this.hint = "Run `npx decree-harness init` to create one (or pass --cwd <project>).";
  }
}

export class SpecParseError extends Error {
  hint: string;
  constructor(public file: string, detail: string) {
    super(`${file} is not valid JSON: ${detail}`);
    this.name = "SpecParseError";
    this.hint = "Fix the syntax error, or delete the file and re-run `decree-harness init`.";
  }
}

export class SpecValidationError extends Error {
  hint: string;
  constructor(public file: string, public errors: string[]) {
    super(`${file} is invalid (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
    this.name = "SpecValidationError";
    this.hint = "Fix the fields above; `decree-harness schema` prints the full JSON schema.";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function specExists(root: string): Promise<boolean> {
  return exists(projectPaths(root).specPath);
}

/** Read, parse and validate decree.json. Throws friendly errors that name the file. */
export async function loadSpec(root: string): Promise<{ spec: HarnessSpec; warnings: string[]; path: string }> {
  const file = projectPaths(root).specPath;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new SpecNotFoundError(file);
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new SpecParseError(file, (err as Error).message);
  }
  const res = validateSpec(json);
  if (!res.ok) throw new SpecValidationError(file, res.errors);
  return { spec: res.spec, warnings: res.warnings, path: file };
}

/** Serialize a spec with `$schema` first and stable 2-space formatting. */
export function serializeSpec(spec: HarnessSpec): string {
  const { $schema, ...rest } = spec;
  return `${JSON.stringify({ $schema: $schema ?? SCHEMA_REF, ...rest }, null, 2)}\n`;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

/** Write decree.json (backing up the previous one to .decree/decree.backup.json) and .decree/schema.json. */
export async function saveSpec(root: string, spec: HarnessSpec, opts: { backup?: boolean } = {}): Promise<string> {
  const paths = projectPaths(root);
  await ensureCacheDir(root);
  if (opts.backup !== false && (await exists(paths.specPath))) {
    const prev = await fs.readFile(paths.specPath, "utf8");
    if (prev !== serializeSpec(spec)) await fs.writeFile(path.join(paths.cacheDir, "decree.backup.json"), prev, "utf8");
  }
  await writeAtomic(paths.specPath, serializeSpec(spec));
  await writeSchema(root);
  return paths.specPath;
}

export async function writeSchema(root: string): Promise<string> {
  const { schemaPath } = projectPaths(root);
  await ensureCacheDir(root);
  await writeAtomic(schemaPath, `${JSON.stringify(specJsonSchema(), null, 2)}\n`);
  return schemaPath;
}

export async function saveProfile(root: string, profile: ProjectProfile): Promise<string> {
  const { profilePath } = projectPaths(root);
  await ensureCacheDir(root);
  // Never persist hardcoded secrets quoted from the README (keyfile excerpts are masked at scan time;
  // the description may be the README's first paragraph).
  const safe: ProjectProfile = { ...profile };
  if (profile.description) safe.description = maskSecrets(profile.description);
  if (profile.docs?.readme) safe.docs = { ...profile.docs, readme: maskSecrets(profile.docs.readme) };
  await writeAtomic(profilePath, `${JSON.stringify(safe, null, 2)}\n`);
  return profilePath;
}

export async function loadProfile(root: string): Promise<ProjectProfile | undefined> {
  try {
    return JSON.parse(await fs.readFile(projectPaths(root).profilePath, "utf8")) as ProjectProfile;
  } catch {
    return undefined;
  }
}

export const CACHE_GITIGNORE = "runs/\nmemory/\nprofile.json\n";

/** Create .decree/ with a .gitignore that keeps transient state out of git. */
export async function ensureCacheDir(root: string): Promise<string> {
  const { cacheDir } = projectPaths(root);
  await fs.mkdir(cacheDir, { recursive: true });
  const gi = path.join(cacheDir, ".gitignore");
  if (!(await exists(gi))) await fs.writeFile(gi, CACHE_GITIGNORE, "utf8");
  return cacheDir;
}

/** Minimal .env reader (KEY=VALUE, optional quotes, # comments). Never logs values. */
export async function readDotEnv(root: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, ".env"), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
