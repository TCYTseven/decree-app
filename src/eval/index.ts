import type Anthropic from "@anthropic-ai/sdk";
import type { EvalCase, EvalResult, HarnessSpec, JSONSchema, LLM, RunResult } from "../core/types.js";
import { createRuntimeClient, runAgentWithClient, type MessagesClientLike } from "../runtime/index.js";

export interface EvalOptions {
  projectRoot: string;
  apiKey?: string;
  judge?: LLM; // used for rubric grading
  filter?: string; // only run cases whose id includes this
  concurrency?: number; // default 2
  dryRunTools?: boolean; // default true: tools describe instead of execute
  onResult?: (r: EvalResult) => void;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number; // 0..1
  avgScore: number; // 0..1
  costUsd: number;
}

const JUDGE_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean", description: "Whether the agent's behavior satisfies the rubric" },
    score: { type: "number", description: "0..1, how well the rubric is satisfied" },
    reason: { type: "string", description: "One or two sentences explaining the grade" },
  },
  required: ["pass", "score", "reason"],
  additionalProperties: false,
};

const JUDGE_SYSTEM =
  "You are a strict evaluator of an AI agent's behavior. You are given the user's request, the tools the agent called " +
  "(with truncated outputs), and the agent's final answer. Grade ONLY against the rubric. Tool side effects were simulated " +
  "(dry run), so judge the agent's decisions and answer, not whether the environment changed.";

type Verdict = { pass: boolean; score: number; reason: string };

/** A check skipped for lack of a judge: reported in `checks` but excluded from the score. */
export const SKIPPED_PREFIX = "skipped:";

async function gradeRubric(judge: LLM, c: EvalCase, run: RunResult): Promise<Verdict> {
  const calls = run.toolCalls
    .map((t, i) => `${i + 1}. ${t.name}(${JSON.stringify(t.input)})${t.isError ? " [error]" : ""} -> ${t.output.slice(0, 500)}`)
    .join("\n");
  const prompt = [
    `<rubric>\n${c.expect.rubric}\n</rubric>`,
    `<user_request>\n${c.input}\n</user_request>`,
    `<tool_calls>\n${calls || "(none)"}\n</tool_calls>`,
    `<final_answer>\n${run.finalText || "(empty)"}\n</final_answer>`,
    "Return pass, score (0..1) and reason.",
  ].join("\n\n");
  const v = await judge.generateJSON<Verdict>({ system: JUDGE_SYSTEM, prompt, schema: JUDGE_SCHEMA, effort: "low", maxTokens: 2000 });
  const score = Math.min(1, Math.max(0, Number(v?.score) || 0));
  return { pass: !!v?.pass, score, reason: String(v?.reason ?? "") };
}

/** Deterministic + judge checks for one finished run. */
export async function checkCase(c: EvalCase, run: RunResult, judge?: LLM): Promise<EvalResult["checks"]> {
  const checks: EvalResult["checks"] = [];
  // A tool counts as "called" when the agent attempted it, even if it was denied or failed.
  const called = new Set(run.toolCalls.map((t) => t.name));
  const answer = run.finalText.toLowerCase();

  for (const name of c.expect.toolsCalled ?? []) {
    checks.push({ name: `toolsCalled: ${name}`, passed: called.has(name), detail: called.has(name) ? undefined : `not called (called: ${[...called].join(", ") || "none"})` });
  }
  for (const name of c.expect.toolsNotCalled ?? []) {
    checks.push({ name: `toolsNotCalled: ${name}`, passed: !called.has(name), detail: called.has(name) ? "was called" : undefined });
  }
  for (const s of c.expect.contains ?? []) {
    const hit = answer.includes(s.toLowerCase());
    checks.push({ name: `contains: ${JSON.stringify(s)}`, passed: hit, detail: hit ? undefined : "not found in final answer" });
  }
  for (const s of c.expect.notContains ?? []) {
    const hit = answer.includes(s.toLowerCase());
    checks.push({ name: `notContains: ${JSON.stringify(s)}`, passed: !hit, detail: hit ? "found in final answer" : undefined });
  }
  if (c.expect.rubric) {
    if (!judge) {
      checks.push({ name: "rubric", passed: true, detail: `${SKIPPED_PREFIX} no judge configured (rubric not graded, excluded from score)` });
    } else {
      try {
        const v = await gradeRubric(judge, c, run);
        checks.push({ name: "rubric", passed: v.pass, detail: `score ${v.score.toFixed(2)}: ${v.reason}` });
      } catch (err) {
        checks.push({ name: "rubric", passed: false, detail: `judge failed: ${(err as Error).message}` });
      }
    }
  }
  return checks;
}

const isSkipped = (ch: EvalResult["checks"][number]) => !!ch.detail?.startsWith(SKIPPED_PREFIX);

export function scoreChecks(checks: EvalResult["checks"]): { passed: boolean; score: number } {
  const counted = checks.filter((ch) => !isSkipped(ch));
  if (!counted.length) return { passed: true, score: 1 };
  const ok = counted.filter((ch) => ch.passed).length;
  return { passed: ok === counted.length, score: ok / counted.length };
}

async function runCase(spec: HarnessSpec, c: EvalCase, opts: EvalOptions, client: MessagesClientLike | Anthropic): Promise<EvalResult> {
  try {
    const run = await runAgentWithClient(
      spec,
      {
        projectRoot: opts.projectRoot,
        prompt: c.input,
        apiKey: opts.apiKey,
        dryRun: opts.dryRunTools ?? true,
        approve: async () => false,
      },
      client,
    );
    const checks = await checkCase(c, run, opts.judge);
    const { passed, score } = scoreChecks(checks);
    return {
      id: c.id,
      passed,
      score,
      checks,
      run: { finalText: run.finalText, turns: run.turns, toolCalls: run.toolCalls, costUsd: run.costUsd },
    };
  } catch (err) {
    return { id: c.id, passed: false, score: 0, checks: [], error: (err as Error).message ?? String(err) };
  }
}

/** Same as runEvals, with an injected client (the real SDK client, or a test double). */
export async function runEvalsWithClient(
  spec: HarnessSpec,
  opts: EvalOptions,
  client: MessagesClientLike | Anthropic,
): Promise<EvalResult[]> {
  const cases = spec.evals.filter((c) => !opts.filter || c.id.includes(opts.filter));
  const results: EvalResult[] = new Array(cases.length);
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 2));
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const r = await runCase(spec, cases[i], opts, client);
      results[i] = r;
      try {
        opts.onResult?.(r);
      } catch {
        /* reporting must not break the run */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, cases.length) }, worker));
  return results;
}

export async function runEvals(spec: HarnessSpec, opts: EvalOptions): Promise<EvalResult[]> {
  // Resolve the key once: a missing key is a configuration error, not a per-case failure.
  return runEvalsWithClient(spec, opts, createRuntimeClient(opts.apiKey));
}

export function summarizeEvals(results: EvalResult[]): EvalSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const errored = results.filter((r) => r.error).length;
  const avgScore = total ? results.reduce((s, r) => s + r.score, 0) / total : 0;
  const costUsd = results.reduce((s, r) => s + (r.run?.costUsd ?? 0), 0);
  return { total, passed, failed: total - passed, errored, passRate: total ? passed / total : 0, avgScore, costUsd };
}
