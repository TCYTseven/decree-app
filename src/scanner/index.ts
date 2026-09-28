import { promises as fs } from "node:fs";
import path from "node:path";
import type { ApiEndpoint, ProjectProfile } from "../core/types.js";
import { detectCli } from "./cli.js";
import { isAnalyzableSource, ScanContext } from "./context.js";
import { detectDatabase } from "./database.js";
import { detectAgentConfig, detectDocs, readmeSummary } from "./docs.js";
import { detectEnvVars } from "./env.js";
import { detectFrameworks } from "./frameworks.js";
import { readGitInfo } from "./git.js";
import { selectKeyFiles } from "./keyfiles.js";
import { detectLanguages } from "./languages.js";
import { choosePackageManager, parseManifests } from "./manifests.js";
import { extractOpenApi } from "./openapi.js";
import { dedupeEndpoints, detectRoutes } from "./routes/index.js";
import { renderTree } from "./tree.js";
import { walkProject } from "./walk.js";
import { decisionSourcesOf } from "../decisions/extract.js";
import { detectWorkspaces, tagEndpointsByWorkspace, workspaceScripts } from "./workspaces.js";

export interface ScanOptions {
  maxFiles?: number; // default 20000; stop walking after this many files and set stats.truncated
  onProgress?: (message: string) => void;
}

/** Caps on how much source we read for route/env/model detection. */
const MAX_SOURCE_FILES = 6000;
const MAX_SOURCE_BYTES = 48 * 1024 * 1024;

/** Deterministically scan a repository. No network access. */
/** Monorepo tools name the root package generically (Nx: `@org/source`); prefer the scope or directory then. */
const GENERIC_ROOT_NAMES = /^(source|src|root|workspace|monorepo|repo|app|project|main)$/i;

export function projectName(manifestName: string | undefined, absRoot: string): string {
  const dir = path.basename(absRoot);
  if (!manifestName) return dir;
  const m = /^@([^/]+)\/(.+)$/.exec(manifestName);
  const bare = m ? m[2]! : manifestName;
  if (!GENERIC_ROOT_NAMES.test(bare)) return manifestName;
  if (dir && !GENERIC_ROOT_NAMES.test(dir)) return dir;
  return m && !GENERIC_ROOT_NAMES.test(m[1]!) ? m[1]! : manifestName;
}

export async function scanProject(root: string, opts: ScanOptions = {}): Promise<ProjectProfile> {
  const started = Date.now();
  const absRoot = path.resolve(root);
  const progress = (msg: string) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* progress callbacks must not break the scan */
    }
  };
  const maxFiles = opts.maxFiles ?? 20000;
  let rootStat: import("node:fs").Stats;
  try {
    rootStat = await fs.stat(absRoot);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? `Cannot scan ${absRoot}: no such directory` : `Cannot scan ${absRoot}: ${code ?? String(e)}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`Cannot scan ${absRoot}: not a directory`);

  progress("Walking files");
  const walk = await walkProject(absRoot, maxFiles);
  progress(`Found ${walk.files.length} files in ${walk.dirs.length} directories${walk.truncated ? " (truncated)" : ""}`);
  const ctx = new ScanContext(absRoot, walk);

  progress("Reading manifests");
  const manifests = await parseManifests(ctx);

  progress("Detecting languages");
  const { languages, primaryLanguage } = detectLanguages(walk.files);

  progress("Reading source files");
  const sourceList: string[] = [];
  let bytes = 0;
  for (const f of walk.files) {
    if (!isAnalyzableSource(f)) continue;
    if (sourceList.length >= MAX_SOURCE_FILES || bytes + f.size > MAX_SOURCE_BYTES) break;
    sourceList.push(f.path);
    bytes += f.size;
  }
  const sources = await ctx.readMany(sourceList);

  progress("Detecting frameworks");
  const frameworks = detectFrameworks(manifests.dependencies, ctx, manifests.hints);
  for (const fw of frameworksFromImports(sources)) if (!frameworks.includes(fw)) frameworks.push(fw);

  progress("Looking for OpenAPI specs");
  const openapi = await extractOpenApi(ctx);
  if (openapi.specs.length) progress(`Parsed ${openapi.endpoints.length} endpoints from ${openapi.specs.length} OpenAPI spec(s)`);

  progress(`Detecting routes in ${sources.size} source files`);
  const codeRoutes = detectRoutes(sources);
  const apis: ApiEndpoint[] = dedupeEndpoints([...openapi.endpoints, ...dropPrefixlessDuplicates(codeRoutes, openapi.endpoints)]);
  progress(`Found ${apis.length} API endpoints`);

  const pm = choosePackageManager(manifests.packageManagers, primaryLanguage);
  const workspaces = await detectWorkspaces(ctx, manifests.workspaces).catch(() => []);
  if (workspaces.length >= 2) {
    progress(`Monorepo with ${workspaces.length} workspaces`);
    tagEndpointsByWorkspace(apis, workspaces);
  }

  progress("Collecting environment variables");
  const envVars = await detectEnvVars(ctx, sources);

  progress("Detecting database");
  const database = await detectDatabase(ctx, sources, manifests.dependencies);

  progress("Reading docs");
  const docs = await detectDocs(ctx);
  const existingAgentConfig = detectAgentConfig(absRoot);
  const cli = detectCli(ctx, manifests, manifests.dependencies, sources);
  const git = await readGitInfo(absRoot);

  const name = projectName(manifests.name, absRoot);
  const tree = renderTree(path.basename(absRoot) || name, walk);

  progress("Selecting key files");
  const keyFiles = await selectKeyFiles(ctx, {
    manifests,
    apis,
    codeRoutes,
    openapiSpecs: openapi.specs,
    schemaFiles: database?.schemaFiles ?? [],
    frameworks,
  });

  const profile: ProjectProfile = {
    root: absRoot,
    name,
    languages,
    frameworks,
    scripts: workspaces.length >= 2 ? [...manifests.scripts, ...workspaceScripts(workspaces, pm, manifests.scripts)] : manifests.scripts,
    apis,
    openapiSpecs: openapi.specs,
    envVars,
    dependencies: manifests.dependencies,
    docs,
    existingAgentConfig,
    tree,
    keyFiles,
    stats: { files: walk.files.length, dirs: walk.dirs.length, truncated: walk.truncated, scanMs: 0 },
  };
  const description = manifests.description ?? readmeSummary(docs.readme);
  if (description) profile.description = description;
  if (primaryLanguage) profile.primaryLanguage = primaryLanguage;
  if (pm) profile.packageManager = pm;
  if (cli) profile.cli = cli;
  if (database) profile.database = database;
  if (git) profile.git = git;
  const decisionSources = decisionSourcesOf(walk).map((f) => f.path);
  if (decisionSources.length) profile.decisionSources = decisionSources.slice(0, 50);
  profile.stats.scanMs = Date.now() - started;
  progress(`Scan complete in ${profile.stats.scanMs}ms`);
  return profile;
}

/**
 * A code route that matches a spec route except for a short mount prefix the detector could not see
 * (`GET /users/{id}` in code, `GET /api/v1/users/{id}` in openapi.yaml) is the same endpoint: keep the spec's.
 */
export function dropPrefixlessDuplicates(code: ApiEndpoint[], spec: ApiEndpoint[]): ApiEndpoint[] {
  if (!spec.length) return code;
  const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "").toLowerCase();
  const specKeys = spec.map((e) => ({ method: e.method, path: norm(e.path) }));
  return code.filter((c) => {
    const p = norm(c.path);
    if (!p || p === "/" || p.split("/").length < 2) return true;
    return !specKeys.some((s) => {
      if (s.method !== c.method || s.path.length <= p.length || !s.path.endsWith(p)) return false;
      const prefix = s.path.slice(0, s.path.length - p.length);
      return /^(\/[\w.-]+){1,2}$/.test(prefix);
    });
  });
}

/** Framework hints from imports, for projects without (parseable) manifests. */
function frameworksFromImports(sources: Map<string, string>): string[] {
  const found = new Set<string>();
  const rules: [string, RegExp, RegExp][] = [
    ["fastapi", /\.py$/, /^\s*from\s+fastapi\s+import|^\s*import\s+fastapi/m],
    ["flask", /\.py$/, /^\s*from\s+flask\s+import/m],
    ["django", /\.py$/, /^\s*from\s+django\./m],
    ["starlette", /\.py$/, /^\s*from\s+starlette[\s.]/m],
    ["gin", /\.go$/, /"github\.com\/gin-gonic\/gin"/],
    ["echo", /\.go$/, /"github\.com\/labstack\/echo/],
    ["fiber", /\.go$/, /"github\.com\/gofiber\/fiber/],
    ["chi", /\.go$/, /"github\.com\/go-chi\/chi/],
    ["sinatra", /\.rb$/, /require\s+['"]sinatra/],
  ];
  let checked = 0;
  for (const [file, text] of sources) {
    if (checked++ > 3000) break;
    for (const [fw, fileRe, re] of rules) if (!found.has(fw) && fileRe.test(file) && re.test(text)) found.add(fw);
  }
  if (found.has("fastapi")) found.delete("starlette");
  return [...found];
}

