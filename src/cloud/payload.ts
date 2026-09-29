import type { EvalResult, HarnessSpec } from "../core/types.js";
import { maskSecrets } from "../core/mask-secrets.js";
import { DECREE_VERSION } from "../version.js";
import type { GitInfo } from "./git.js";

const FINAL_TEXT_LIMIT = 2000;
const DETAIL_LIMIT = 500;

/** True on CI runners (GitHub Actions and most others set CI=true). */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI?.toLowerCase();
  return Boolean(env.GITHUB_ACTIONS) || (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0");
}

/**
 * The spec as it is uploaded: `$schema` (a local path) is dropped, defaults
 * of secret env vars are removed, and credentials in base URLs are masked.
 */
export function specForUpload(spec: HarnessSpec): Omit<HarnessSpec, "$schema"> {
  const { $schema: _schema, ...rest } = spec;
  return {
    ...rest,
    env: spec.env.map((e) => {
      if (!e.secret || e.default === undefined) return e;
      const { default: _default, ...kept } = e;
      return kept;
    }),
    tools: spec.tools.map((t) =>
      t.http?.defaultBaseUrl ? { ...t, http: { ...t.http, defaultBaseUrl: maskSecrets(t.http.defaultBaseUrl) } } : t,
    ),
  };
}

export interface SyncPayload {
  spec: Omit<HarnessSpec, "$schema">;
  slug?: string;
  message?: string;
  git: GitInfo;
  source: "cli" | "ci";
  cliVersion: string;
}

export function buildSyncPayload(
  spec: HarnessSpec,
  opts: { git: GitInfo; message?: string; slug?: string; env?: NodeJS.ProcessEnv },
): SyncPayload {
  const payload: SyncPayload = {
    spec: specForUpload(spec),
    git: opts.git,
    source: isCI(opts.env) ? "ci" : "cli",
    cliVersion: DECREE_VERSION,
  };
  if (opts.slug) payload.slug = opts.slug;
  if (opts.message?.trim()) payload.message = opts.message.trim();
  return payload;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Eval results as uploaded: tool names only (never tool inputs or outputs,
 * which can hold customer data), and a masked, shortened final answer.
 */
export function evalResultsForUpload(results: EvalResult[]) {
  return results.map((r) => ({
    id: r.id,
    passed: r.passed,
    score: Number.isFinite(r.score) ? r.score : 0,
    ...(r.error ? { error: clip(maskSecrets(r.error), DETAIL_LIMIT) } : {}),
    checks: r.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      ...(c.detail ? { detail: clip(maskSecrets(c.detail), DETAIL_LIMIT) } : {}),
    })),
    ...(r.run
      ? {
          turns: r.run.turns,
          toolCalls: r.run.toolCalls.map((t) => t.name),
          costUsd: r.run.costUsd,
          finalText: clip(maskSecrets(r.run.finalText ?? ""), FINAL_TEXT_LIMIT),
        }
      : {}),
  }));
}

export interface EvalSummaryLike {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  score: number;
  costUsd: number;
}

export function buildEvalPayload(
  spec: HarnessSpec,
  results: EvalResult[],
  summary: EvalSummaryLike,
  opts: { git: GitInfo; model: string; liveTools: boolean; filter?: string; durationMs: number; env?: NodeJS.ProcessEnv },
) {
  return {
    ...buildSyncPayload(spec, { git: opts.git, env: opts.env }),
    evals: {
      summary,
      results: evalResultsForUpload(results),
      model: opts.model,
      liveTools: opts.liveTools,
      ...(opts.filter ? { filter: opts.filter } : {}),
      durationMs: Math.round(opts.durationMs),
    },
  };
}
