import path from "node:path";
import type { ApiEndpoint, KeyFile } from "../core/types.js";
import { isFixturePath, isTestPath, type ScanContext } from "./context.js";
import type { ManifestResult } from "./manifests.js";

export const KEYFILE_MAX = 12;
export const KEYFILE_EXCERPT_CHARS = 3000;
export const KEYFILE_TOTAL_CHARS = 30000;

interface Candidate {
  path: string;
  reason: string;
  score: number;
  limit?: number;
}

const ENTRY_RE = /^(index|main|app|server|cli|application|wsgi|asgi|program|lib|mod|init|bootstrap)\.(ts|tsx|js|mjs|cjs|py|go|rs|rb|php|java|kt)$/;
const CONFIG_NAMES = new Set([
  "config.ts", "config.js", "config.py", "settings.py", "config.go", "env.ts", "env.js", "env.mjs", "config.rb",
  "next.config.js", "next.config.mjs", "next.config.ts", "nest-cli.json", "vite.config.ts", "docker-compose.yml",
  "docker-compose.yaml", "compose.yaml", "compose.yml", "Dockerfile", "application.yml", "application.properties",
  "wrangler.toml", "serverless.yml", "vercel.json", "fly.toml",
]);

function excerpt(text: string, limit: number): string {
  const t = text.replace(/\r\n/g, "\n");
  if (t.length <= limit) return t;
  const cut = t.lastIndexOf("\n", limit);
  const at = cut > limit * 0.6 ? cut : limit;
  const remaining = t.slice(at).split("\n").length - 1;
  return t.slice(0, at) + `\n… [truncated, ${remaining} more lines]`;
}

export async function selectKeyFiles(
  ctx: ScanContext,
  opts: { manifests: ManifestResult; apis: ApiEndpoint[]; codeRoutes?: ApiEndpoint[]; openapiSpecs: string[]; schemaFiles: string[]; frameworks: string[] },
): Promise<KeyFile[]> {
  const cands = new Map<string, Candidate>();
  const add = (p: string | undefined, reason: string, score: number, limit?: number) => {
    if (!p || !ctx.has(p)) return;
    const e = ctx.byPath.get(p)!;
    if (e.size === 0 || e.size > 1024 * 1024) return;
    const prev = cands.get(p);
    if (!prev) cands.set(p, { path: p, reason, score, limit });
    else {
      if (score > prev.score) {
        prev.score = score;
        prev.reason = reason;
      } else if (!prev.reason.includes(reason)) prev.reason = `${prev.reason}, ${reason}`;
      prev.score += 5;
    }
  };

  // Agent instructions already written by humans are the highest-signal context.
  add(ctx.first("CLAUDE.md", ".claude/CLAUDE.md"), "existing agent instructions (CLAUDE.md)", 100);
  add(ctx.first("AGENTS.md"), "existing agent instructions (AGENTS.md)", 98);

  // CLI entry points.
  for (const b of opts.manifests.bins) {
    if (!b.entry) continue;
    if (b.ecosystem === "npm") {
      const e = path.posix.normalize(b.entry);
      const srcGuess = e.replace(/^(dist|build|lib|out)\//, "src/").replace(/\.(c|m)?js$/, "");
      const cand = ctx.first(e, `${srcGuess}.ts`, `${srcGuess}.tsx`, `${srcGuess}.js`, `${srcGuess}.mts`);
      add(cand && /\.[cm]?[jt]sx?$/.test(cand) ? cand : undefined, `CLI entry (${b.name})`, 80);
    } else if (b.ecosystem === "pypi") {
      const mod = b.entry.split(":")[0]!.replace(/\./g, "/");
      add(ctx.first(`${mod}.py`, `src/${mod}.py`, `${mod}/__init__.py`, `src/${mod}/__init__.py`), `CLI entry (${b.name})`, 80);
    }
  }

  // Route files, ranked by how many endpoints they declare.
  const perFile = new Map<string, number>();
  for (const a of opts.codeRoutes ?? opts.apis) {
    if (!/:\d+$/.test(a.source)) continue;
    const f = a.source.replace(/:\d+$/, "");
    perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }
  [...perFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([f, n], i) => add(f, `router (${n} endpoint${n === 1 ? "" : "s"})`, 70 - i * 4));

  // OpenAPI: endpoints are already extracted, so only the head (servers, auth) matters.
  if (opts.openapiSpecs[0]) add(opts.openapiSpecs[0], "OpenAPI spec (servers, security)", 55, 1500);

  // Entrypoints (a handful: nested module index files are rarely the real entry).
  const entries = ctx.files
    .filter((f) => ENTRY_RE.test(f.name) && f.depth <= 3 && !isTestPath(f.path) && !isFixturePath(f.path))
    .map((f) => {
      const dir = path.posix.dirname(f.path);
      const base = f.name.replace(/\.[^.]+$/, "");
      let score = 60 - f.depth * 10;
      if (dir === "." || dir === "src" || dir === "app" || /^cmd\/[^/]+$/.test(dir)) score += 8;
      if (["main", "server", "app"].includes(base)) score += 4;
      if (base === "mod" || base === "lib" || base === "init") score -= 10;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  for (const { f, score } of entries) add(f.path, "entrypoint", score);
  // A tiny bin/entry file usually just imports the real program: follow one hop.
  for (const c of [...cands.values()].filter((c) => c.reason.startsWith("CLI entry"))) {
    const text = await ctx.read(c.path);
    if (!text || text.length > 600) continue;
    const imp = /(?:import|from)\s*\(?\s*['"](\.[^'"]+)['"]/.exec(text)?.[1];
    if (!imp) continue;
    const base = path.posix.join(path.posix.dirname(c.path), imp).replace(/\.(c|m)?js$/, "");
    add(ctx.first(base + ".ts", base + ".tsx", base + ".js", base + ".mjs", base + "/index.ts", base + "/index.js"), "CLI program", 78);
  }
  // Architecture / contributor docs written for humans are great planner context.
  const docs = ctx.files
    .filter((f) => f.depth <= 2 && /^(architecture|design|overview|contributing|development|hacking|conventions)\.(md|mdx|rst)$/i.test(f.name) && !isFixturePath(f.path))
    .slice(0, 2);
  docs.forEach((f, i) => add(f.path, "architecture / contributor docs", 64 - i * 8));
  add(ctx.first("manage.py"), "entrypoint (django)", 40);
  add(ctx.first("config/routes.rb"), "router", 66);
  add(ctx.first("main.go"), "entrypoint", 62);

  // Handlers / controllers / services hold the business logic behind the routes.
  const logic = ctx.files
    .filter(
      (f) =>
        f.depth <= 3 &&
        /(^|\/)(handlers?|controllers?|services?|views|resolvers|usecases?)\/[^/]+\.(ts|js|py|go|rb|php|java|kt|rs)$/.test(f.path) &&
        !isTestPath(f.path) &&
        !/(^|\/)(index|__init__)\.[a-z]+$/.test(f.path),
    )
    .sort((a, b) => b.size - a.size)
    .slice(0, 2);
  logic.forEach((f, i) => add(f.path, "handlers / business logic", 50 - i * 5));

  // Schemas and models.
  const schemaFiles = opts.schemaFiles.filter((s) => !s.endsWith("/"));
  schemaFiles.slice(0, 2).forEach((s, i) => add(s, "database schema", 58 - i * 6));

  // Config.
  for (const f of ctx.files) {
    if (f.depth > 2 || isTestPath(f.path)) continue;
    if (CONFIG_NAMES.has(f.name)) add(f.path, "config", f.name.startsWith("docker") || f.name === "Dockerfile" ? 30 : 42 - f.depth * 4);
  }

  // Root manifest: scripts/deps already parsed, but the raw file is compact and informative.
  add(ctx.first("package.json"), "manifest", 44, 2000);
  add(ctx.first("pyproject.toml"), "manifest", 44, 2000);
  add(ctx.first("go.mod"), "manifest", 25, 1200);
  add(ctx.first("Cargo.toml"), "manifest", 30, 1500);
  add(ctx.first("Makefile"), "task runner", 28, 2000);

  const ranked = [...cands.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const out: KeyFile[] = [];
  let total = 0;
  for (const c of ranked) {
    if (out.length >= KEYFILE_MAX) break;
    const budget = Math.min(c.limit ?? KEYFILE_EXCERPT_CHARS, KEYFILE_TOTAL_CHARS - total);
    if (budget < 400) break;
    const text = await ctx.read(c.path);
    if (!text || !text.trim()) continue;
    const ex = excerpt(text, budget);
    total += ex.length;
    out.push({ path: c.path, reason: c.reason, excerpt: ex });
  }
  return out;
}
