import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { EvalResult } from "../core/types.js";
import { loadSpec } from "../core/config.js";
import { runEvals } from "../eval/index.js";
import { MissingApiKeyError } from "../llm/client.js";
import { banner } from "../ui/banner.js";
import { CliError, SilentExit } from "../ui/errors.js";
import { formatUsd, groupWarnings, plural } from "../ui/format.js";
import { log, setQuiet } from "../ui/logger.js";
import { createSpinner } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import { c, sym, termWidth } from "../ui/theme.js";
import { cloud, type PushResult } from "../cloud/api.js";
import { gitInfo } from "../cloud/git.js";
import { buildEvalPayload } from "../cloud/payload.js";
import { rootFor, selfCommand } from "./context.js";
import { findApiKey, llmCost, makeLLM } from "./pipeline.js";
import { pushedLine, requireAuth } from "./push.js";

export interface EvalCmdOptions {
  filter?: string;
  liveTools?: boolean;
  concurrency?: string;
  model?: string;
  apiKey?: string;
  json?: boolean;
  push?: boolean;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  score: number; // mean 0..1
  costUsd: number;
}

export function summarizeResults(results: EvalResult[], judgeCost = 0): EvalSummary {
  const passed = results.filter((r) => r.passed).length;
  const errored = results.filter((r) => r.error).length;
  const score = results.length ? results.reduce((a, r) => a + (Number.isFinite(r.score) ? r.score : 0), 0) / results.length : 0;
  const costUsd = results.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0) + judgeCost;
  return { total: results.length, passed, failed: results.length - passed, errored, score, costUsd };
}

export async function evalCommand(opts: EvalCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (opts.json) setQuiet(true);
  const concurrency = opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined;
  if (concurrency !== undefined && (!Number.isFinite(concurrency) || concurrency < 1)) {
    throw new CliError(`--concurrency must be a positive integer (got "${opts.concurrency}")`);
  }
  const { spec, warnings } = await loadSpec(root);
  const { key } = await findApiKey(root, opts.apiKey);
  if (!key) throw new MissingApiKeyError();
  // Check the login before spending tokens on the run.
  const auth = opts.push ? await requireAuth() : undefined;
  const cases = spec.evals.filter((e) => !opts.filter || e.id.includes(opts.filter));
  if (!cases.length) {
    throw new CliError(opts.filter ? `No eval ids match "${opts.filter}"` : "decree.json has no evals", {
      hint: opts.filter ? `Available: ${spec.evals.map((e) => e.id).join(", ")}` : `Add some with: ${selfCommand()} refine "add evals for ..."`,
    });
  }

  if (!opts.json) {
    p.intro(banner("eval"));
    for (const w of groupWarnings(warnings)) log.warn(w);
    log.info(
      `${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${plural(cases.length, "case")} ${sym.dot} ${opts.liveTools ? c.yellow("live tools") : "tools in dry-run mode"}`)}`,
    );
  }
  const judge = makeLLM(key, opts.model);
  const spin = createSpinner();
  const startedAt = Date.now();
  let done = 0;
  spin.start(`Running ${plural(cases.length, "eval")}…`);
  let results: EvalResult[];
  try {
    results = await runEvals(opts.model ? { ...spec, model: { ...spec.model, id: opts.model } } : spec, {
      projectRoot: root,
      apiKey: key,
      judge,
      filter: opts.filter,
      concurrency,
      dryRunTools: !opts.liveTools,
      onResult: (r) => {
        done++;
        spin.message(`${done}/${cases.length} ${r.passed ? c.green(sym.ok) : c.red(sym.fail)} ${r.id}`);
      },
    });
  } catch (err) {
    spin.error("Evals failed to run");
    throw err;
  }
  const summary = summarizeResults(results, llmCost(judge));
  const durationMs = Date.now() - startedAt;
  spin.stop(`Ran ${plural(results.length, "eval")}`);

  let pushed: PushResult | undefined;
  let pushError: unknown;
  if (auth) {
    const payload = buildEvalPayload(spec, results, summary, {
      git: await gitInfo(root),
      model: opts.model ?? spec.model.id,
      liveTools: Boolean(opts.liveTools),
      filter: opts.filter,
      durationMs,
    });
    pushed = await cloud.pushEvals(auth.apiUrl, auth.token, payload).catch((err) => {
      pushError = err;
      return undefined;
    });
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ summary, results, ...(pushed ? { push: pushed } : {}) }, null, 2)}\n`);
  } else {
    const rows = results.map((r) => [
      r.passed ? c.green(sym.ok) : c.red(sym.fail),
      r.passed ? r.id : c.bold(r.id),
      `${Math.round(r.score * 100)}%`,
      r.run ? String(r.run.turns) : "–",
      r.run ? String(r.run.toolCalls.length) : "–",
      r.run ? formatUsd(r.run.costUsd) : "–",
    ]);
    log.message(
      renderTable(
        [{ header: "" }, { header: "Eval", min: 12 }, { header: "Score", align: "right" }, { header: "Turns", align: "right" }, { header: "Tools", align: "right" }, { header: "Cost", align: "right" }],
        rows,
        { width: termWidth() - 4 },
      ),
    );
    for (const r of results.filter((x) => !x.passed)) {
      const lines = [`${c.red(sym.fail)} ${c.bold(r.id)}`];
      if (r.error) lines.push(`  ${c.red(r.error)}`);
      for (const ch of r.checks.filter((x) => !x.passed)) lines.push(`  ${c.red(sym.fail)} ${ch.name}${ch.detail ? c.dim(` ${sym.dash} ${ch.detail}`) : ""}`);
      const mentioned = r.checks.some((ch) => /called:/.test(ch.detail ?? ""));
      if (r.run?.toolCalls.length && !mentioned) lines.push(c.dim(`  called: ${r.run.toolCalls.map((t) => t.name).join(", ")}`));
      log.message(lines.join("\n"));
    }
    const verdict = summary.failed
      ? c.red(`${summary.passed}/${summary.total} passed`)
      : c.green(`${summary.passed}/${summary.total} passed`);
    p.outro(`${verdict} ${c.dim(`${sym.dot} score ${Math.round(summary.score * 100)}% ${sym.dot}`)} ${formatUsd(summary.costUsd)}`);
    if (pushed) log.raw(pushedLine(pushed));
  }
  if (pushError) throw pushError;
  if (summary.failed) throw new SilentExit(1);
}
