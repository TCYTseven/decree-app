import path from "node:path";
import type { ApiEndpoint, ScriptInfo } from "../core/types.js";
import { isFixturePath, type ScanContext } from "./context.js";

export interface Workspace {
  /** POSIX dir relative to the root. */
  dir: string;
  /** Package name (or the dir's base name). */
  name: string;
  /** Short label for tags and script prefixes: unscoped package name. */
  label: string;
  /** Deployable app (apps/*, services/*, or anything with a dev/start script outside packages/). */
  app: boolean;
  scripts: Record<string, string>;
  manifest: string;
}

const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json"];
const APP_DIR_RE = /^(apps?|services?|backend|frontend|server|api|web|sites?)(\/|$)/;
const WORKSPACE_SCRIPTS = ["dev", "start", "build", "test", "lint", "typecheck"];
const MAX_WORKSPACES = 200;
const MAX_WORKSPACE_SCRIPTS = 24;

/** `apps/*`, `packages/**`, `!packages/internal` -> matcher over directory paths. */
function globMatcher(patterns: string[]): (dir: string) => boolean {
  const toRe = (g: string) =>
    new RegExp(
      "^" +
        g
          .replace(/^\.\//, "")
          .replace(/\/+$/, "")
          .replace(/\/\*\*$/, "/**")
          .split("/")
          .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
          .join("/")
          .replace(/\/\(\?:\.\*\)/g, "(?:/.*)?") +
        "$",
    );
  const inc = patterns.filter((p) => !p.startsWith("!")).map(toRe);
  const exc = patterns.filter((p) => p.startsWith("!")).map((p) => toRe(p.slice(1)));
  return (dir) => inc.some((r) => r.test(dir)) && !exc.some((r) => r.test(dir));
}

/**
 * Workspaces of a monorepo: the declared ones (package.json `workspaces`, pnpm-workspace.yaml, Cargo members)
 * or, when none are declared, manifests directly under apps/, services/ and packages/.
 */
export async function detectWorkspaces(ctx: ScanContext, declared: string[]): Promise<Workspace[]> {
  const manifestDirs = new Map<string, string>(); // dir -> manifest path
  for (const f of ctx.files) {
    if (f.depth === 0 || f.depth > 4 || !MANIFESTS.includes(f.name) || isFixturePath(f.path)) continue;
    const dir = path.posix.dirname(f.path);
    if (!manifestDirs.has(dir) || f.name === "package.json") manifestDirs.set(dir, f.path);
  }
  let dirs: string[];
  if (declared.length) {
    const match = globMatcher(declared);
    dirs = [...manifestDirs.keys()].filter(match);
  } else {
    dirs = [...manifestDirs.keys()].filter((d) => /^(apps|services|packages)\/[^/]+$/.test(d));
    if (dirs.length < 2) return [];
  }
  dirs.sort();
  const out: Workspace[] = [];
  for (const dir of dirs.slice(0, MAX_WORKSPACES)) {
    const manifest = manifestDirs.get(dir)!;
    let name = path.posix.basename(dir);
    const scripts: Record<string, string> = {};
    if (manifest.endsWith("package.json")) {
      try {
        const pkg = JSON.parse((await ctx.read(manifest)) ?? "{}") as { name?: unknown; scripts?: unknown };
        if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
        if (pkg.scripts && typeof pkg.scripts === "object")
          for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) if (typeof v === "string") scripts[k] = v;
      } catch {
        /* unparseable package.json: keep the dir name */
      }
    }
    const inPackages = /^(packages|libs?|shared|tooling|config)\//.test(dir);
    const demo = /(^|\/|[-_])(examples?|demos?|samples?|playgrounds?|sandbox)([-_/]|$)/i.test(dir);
    const app = !demo && (APP_DIR_RE.test(dir) || (!inPackages && ("dev" in scripts || "start" in scripts)));
    out.push({ dir, name, label: name.replace(/^@[^/]+\//, ""), app, scripts, manifest });
  }
  // Labels must be unique: fall back to the dir path for collisions.
  const seen = new Map<string, number>();
  for (const w of out) seen.set(w.label, (seen.get(w.label) ?? 0) + 1);
  for (const w of out) if (seen.get(w.label)! > 1) w.label = w.dir.replace(/\//g, "-");
  return out;
}

/** `<pm>`-specific command that runs `script` in one workspace. */
export function workspaceCommand(pm: string | undefined, w: Workspace, script: string): string {
  const named = w.manifest.endsWith("package.json") && w.name !== path.posix.basename(w.dir);
  switch (pm) {
    case "pnpm":
      return `pnpm --filter ${named ? w.name : `./${w.dir}`} run ${script}`;
    case "yarn":
      return named ? `yarn workspace ${w.name} run ${script}` : `yarn --cwd ${w.dir} run ${script}`;
    case "bun":
      return named ? `bun run --filter ${w.name} ${script}` : `bun run --cwd ${w.dir} ${script}`;
    default:
      return `npm run ${script} --workspace=${w.dir}`;
  }
}

/** The common scripts (dev/start/build/test/lint/typecheck) of each app workspace, as root-level scripts. */
export function workspaceScripts(workspaces: Workspace[], pm: string | undefined, existing: ScriptInfo[]): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const taken = new Set(existing.map((s) => s.name));
  for (const w of workspaces) {
    if (!w.app || !w.manifest.endsWith("package.json")) continue;
    for (const s of WORKSPACE_SCRIPTS) {
      if (!(s in w.scripts) || out.length >= MAX_WORKSPACE_SCRIPTS) continue;
      const name = `${w.label}:${s}`;
      if (taken.has(name)) continue;
      taken.add(name);
      out.push({ name, command: workspaceCommand(pm, w, s), source: w.manifest });
    }
  }
  return out;
}

/** Which workspace a file (or `file:line` source) belongs to: the deepest workspace dir containing it. */
export function workspaceOf(workspaces: Workspace[], source: string): Workspace | undefined {
  const file = source.replace(/:\d+$/, "");
  let best: Workspace | undefined;
  for (const w of workspaces) if (file.startsWith(w.dir + "/") && (!best || w.dir.length > best.dir.length)) best = w;
  return best;
}

/** Tag untagged endpoints with the workspace they live in, so a monorepo's APIs stay distinguishable. */
export function tagEndpointsByWorkspace(apis: ApiEndpoint[], workspaces: Workspace[]): void {
  if (workspaces.length < 2) return;
  for (const e of apis) {
    const w = workspaceOf(workspaces, e.source);
    if (!w) continue;
    if (!e.tags?.length) e.tags = [w.label];
  }
}
