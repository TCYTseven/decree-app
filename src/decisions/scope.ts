import path from "node:path";
import type { Decision, DecisionStatus } from "../core/types.js";
import { globMatches, globSpecificity, normalizeRepoPath } from "./glob.js";

export const DEFAULT_DECISION_LIMIT = 8;

export interface ScopeOptions {
  /** Most decisions returned (default 8). */
  limit?: number;
  /** Also return proposed decisions (default false: live only). */
  includeProposed?: boolean;
}

const STATUS_RANK: Record<DecisionStatus, number> = { live: 0, proposed: 1, superseded: 2 };

/**
 * Every decision that governs at least one of `paths`, most specific first: a decision scores the specificity of
 * its most specific matching glob (`src/db/users.ts` beats `src/db/**` beats `src/**` beats `**`). Ties go to
 * live before proposed, then to the order in decree.json. Superseded decisions are never returned.
 */
export function rankDecisions(decisions: Decision[], paths: string[], opts: Pick<ScopeOptions, "includeProposed"> = {}): Decision[] {
  const norm = paths.map(normalizeRepoPath);
  const scored: { d: Decision; score: number; index: number }[] = [];
  decisions.forEach((d, index) => {
    if (d.status !== "live" && !(opts.includeProposed && d.status === "proposed")) return;
    let score = -1;
    for (const glob of d.governs) {
      const s = globSpecificity(glob);
      if (s <= score) continue;
      if (norm.some((p) => globMatches(glob, p))) score = s;
    }
    if (score >= 0) scored.push({ d, score, index });
  });
  scored.sort((a, b) => b.score - a.score || STATUS_RANK[a.d.status] - STATUS_RANK[b.d.status] || a.index - b.index);
  return scored.map((s) => s.d);
}

/** The decisions an agent should see before touching `paths`: live ones (plus proposed if asked), capped at `limit`. */
export function scopeDecisions(decisions: Decision[], paths: string[], opts: ScopeOptions = {}): Decision[] {
  return rankDecisions(decisions, paths, opts).slice(0, clampLimit(opts.limit));
}

function clampLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_DECISION_LIMIT;
}

/**
 * Compact text for a model: one block per decision with its id, title, rule, scope and source. `total` is how many
 * matched before the limit, so the model knows when to narrow its paths.
 */
export function formatDecisions(decisions: Decision[], opts: { total?: number; limit?: number; includeProposed?: boolean } = {}): string {
  if (!decisions.length) return `No ${opts.includeProposed ? "live or proposed " : "live "}decisions govern these paths.`;
  const n = decisions.length;
  const lines = [`${n} decision${n === 1 ? " governs" : "s govern"} these paths, most specific first. Follow them, and cite the id when one constrains your change.`, ""];
  for (const d of decisions) {
    lines.push(`[${d.id}] ${d.title}${d.status === "proposed" ? " (proposed, not yet confirmed)" : ""}`);
    lines.push(`Rule: ${d.constraint}`);
    lines.push(`Governs: ${d.governs.join(", ")} | Source: ${d.source}`);
    lines.push("");
  }
  const more = (opts.total ?? n) - n;
  if (more > 0) lines.push(`${more} more matched but were left out (limit ${clampLimit(opts.limit)}). Pass narrower paths to see them.`);
  return lines.join("\n").trimEnd();
}

/**
 * The `get_decisions` tool: validate `{ paths, include_proposed? }`, make absolute paths inside `projectRoot`
 * repo-relative, and return the formatted decisions. Shared by the runtime and ported to every generated target.
 */
export function runGetDecisions(
  decisions: Decision[],
  input: Record<string, unknown>,
  projectRoot?: string,
  limit = DEFAULT_DECISION_LIMIT,
): { output: string; isError: boolean } {
  const raw = input.paths;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === "string")) {
    return { output: 'Pass "paths": the files or directories you will read or change, e.g. ["src/db/users.ts"].', isError: true };
  }
  const includeProposed = input.include_proposed === true;
  const paths = (list as string[]).map((p) => repoRelative(p, projectRoot));
  const ranked = rankDecisions(decisions, paths, { includeProposed });
  const shown = ranked.slice(0, clampLimit(limit));
  return { output: formatDecisions(shown, { total: ranked.length, limit, includeProposed }), isError: false };
}

function repoRelative(p: string, root: string | undefined): string {
  const posix = p.trim().replace(/\\/g, "/");
  if (!root || !path.isAbsolute(p.trim())) return posix;
  const rel = path.relative(path.resolve(root), path.resolve(p.trim())).split(path.sep).join("/");
  return rel.startsWith("..") ? posix : rel;
}
