import { randomBytes } from "node:crypto";
import type { HarnessSpec } from "../core/types.js";
import { LOCAL_MODEL_PREFIX } from "../llm/pricing.js";
import { runAgentWithClient } from "../runtime/index.js";
import type { MessagesClientLike } from "../runtime/loop.js";
import { modelKey, type LocalModel } from "./endpoints.js";
import { gradeAll, wilson } from "./grade.js";
import { chatOnce, createLocalClient, LocalModelError, type LocalClientOptions } from "./local-client.js";
import { countItems, DOMAINS, generateSuite, tailorFor, type TailorOptions } from "./suite.js";
import type { DomainId, DomainPlan, DomainScore, ItemResult, LabEvent, LabItem, LabRun, LabSuite, ModelRun, Tailoring } from "./types.js";

export interface LabRunOptions {
  projectRoot: string;
  project: string;
  spec: HarnessSpec;
  models: LocalModel[];
  /** Trials per item (pass@1 averaged over samples, as model cards report). Default 1. */
  samples?: number;
  /** Default 0 for one sample (greedy), 0.7 for several. */
  temperature?: number;
  domains?: DomainId[];
  tailor?: TailorOptions;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: LabEvent) => void;
  /** Called with each model's suite before it runs (the CLI saves it). */
  onSuite?: (model: LocalModel, suite: LabSuite) => void | Promise<void>;
  /** Test seam: build the client for a model. */
  clientFor?: (model: LocalModel, opts: Partial<LocalClientOptions>) => MessagesClientLike;
}

const emit = (opts: LabRunOptions, e: LabEvent) => {
  try {
    opts.onEvent?.(e);
  } catch {
    /* reporting must not break the run */
  }
};

/** The harness, pointed at a local model and fitted to its size. Prompt caching and betas don't apply locally. */
export function specForModel(spec: HarnessSpec, model: LocalModel, t: Tailoring): HarnessSpec {
  const id = `${LOCAL_MODEL_PREFIX}${model.id}`;
  return {
    ...spec,
    model: { ...spec.model, id, subagentId: id, thinking: "off" },
    subagents: spec.subagents.map((s) => ({ ...s, model: id })),
    tools: spec.tools.filter((x) => x.kind !== "web_search" && x.kind !== "web_fetch" && x.kind !== "memory"),
    guardrails: { ...spec.guardrails, maxTurns: t.maxTurns, maxOutputTokensPerTurn: t.maxOutputTokens, maxCostUsd: undefined },
    context: { caching: false, compaction: false, contextEditing: false, memory: false },
  };
}

/** One small tool request: does this model/server do native tool calling? */
export async function probeTools(client: MessagesClientLike, signal?: AbortSignal): Promise<boolean> {
  const body = {
    model: "probe",
    max_tokens: 256,
    system: "You call tools when they help.",
    messages: [{ role: "user", content: "What's the weather in Paris right now? Use the tool." }],
    tools: [
      {
        name: "get_weather",
        description: "Current weather for a city.",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
  };
  try {
    await client.messages.stream(body, signal ? { signal } : undefined).finalMessage();
    // The server took the tools. Whether the model then used them is what the evals measure.
    return true;
  } catch (err) {
    if (err instanceof LocalModelError && err.kind === "no_tools") return false;
    throw err;
  }
}

function scoreDomain(d: DomainPlan, results: ItemResult[], skippedReason?: string): DomainScore {
  const rs = results.filter((r) => r.domain === d.id);
  const base = { id: d.id, area: d.area, title: d.title, benchmark: d.benchmark, alertThreshold: d.alertThreshold };
  const reason = skippedReason ?? d.skipped;
  if (reason || !rs.length) {
    return { ...base, status: "skipped", reason: reason ?? "No items ran.", items: d.items.length, trials: 0, passed: 0, rate: 0, ci: [0, 1], errors: 0 };
  }
  const passed = rs.filter((r) => r.passed).length;
  const n = rs.length;
  const [lo, hi] = wilson(passed, n);
  if (d.area === "safety") {
    const rate = (n - passed) / n;
    return {
      ...base,
      status: "ran",
      items: d.items.length,
      trials: n,
      passed,
      rate,
      ci: [1 - hi, 1 - lo],
      alert: d.alertThreshold !== undefined && rate >= d.alertThreshold,
      errors: rs.filter((r) => r.error).length,
    };
  }
  return { ...base, status: "ran", items: d.items.length, trials: n, passed, rate: passed / n, ci: [lo, hi], errors: rs.filter((r) => r.error).length };
}

async function runItem(
  item: LabItem,
  sample: number,
  ctx: { opts: LabRunOptions; model: LocalModel; spec: HarnessSpec; client: MessagesClientLike; makeClient: (o: Partial<LocalClientOptions>) => MessagesClientLike; t: Tailoring; temperature: number },
): Promise<ItemResult> {
  const started = Date.now();
  const seed = sample;
  const base = { id: item.id, domain: item.domain, sample } as const;
  try {
    if (item.kind === "chat") {
      const client = ctx.makeClient({ numCtx: item.numCtx, seed, temperature: ctx.temperature });
      const out = await chatOnce(client, { system: item.system, prompt: item.prompt, maxTokens: ctx.t.maxOutputTokens, signal: ctx.opts.signal });
      const g = gradeAll(item.graders, { answer: out.text, toolCalls: [] });
      return { ...base, ...g, answer: out.text.slice(0, 4000), toolCalls: [], turns: 1, ms: Date.now() - started, inputTokens: out.inputTokens, outputTokens: out.outputTokens };
    }
    const client = sample === 0 && ctx.temperature === 0 ? ctx.client : ctx.makeClient({ seed, temperature: ctx.temperature });
    const run = await runAgentWithClient(
      ctx.spec,
      { projectRoot: ctx.opts.projectRoot, prompt: item.prompt, dryRun: true, approve: async () => false, signal: ctx.opts.signal },
      client,
    );
    const g = gradeAll(item.graders, { answer: run.finalText, toolCalls: run.toolCalls });
    return {
      ...base,
      ...g,
      answer: run.finalText.slice(0, 4000),
      toolCalls: run.toolCalls.map((c) => ({ name: c.name, isError: c.isError })),
      turns: run.turns,
      ms: Date.now() - started,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
    };
  } catch (err) {
    if (err instanceof LocalModelError && (err.kind === "unreachable" || err.kind === "not_found" || err.kind === "no_tools")) throw err;
    if ((err as Error)?.name === "AbortError" || ctx.opts.signal?.aborted) throw err;
    return { ...base, passed: false, score: 0, checks: [], answer: "", toolCalls: [], turns: 0, ms: Date.now() - started, inputTokens: 0, outputTokens: 0, error: (err as Error).message ?? String(err) };
  }
}

/** Fit, generate and run the suite for one model. */
export async function runModel(model: LocalModel, opts: LabRunOptions): Promise<ModelRun> {
  const key = modelKey(model);
  const samples = Math.max(1, Math.floor(opts.samples ?? 1));
  const temperature = opts.temperature ?? (samples > 1 ? 0.7 : 0);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const makeClient = (o: Partial<LocalClientOptions>) =>
    opts.clientFor?.(model, o) ??
    createLocalClient({ origin: model.origin, dialect: model.dialect, model: model.id, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, temperature, ...o });

  let tailoring = tailorFor(model, opts.spec, opts.tailor);
  const fail = (error: string, status: ModelRun["status"] = "failed"): ModelRun => ({
    model,
    tailoring,
    status,
    error,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    domains: [],
    alerts: 0,
    results: [],
  });

  const plainClient = makeClient({ maxOutputTokens: tailoring.maxOutputTokens });
  const needsAgent = DOMAINS.some((d) => d.needsTools && (!opts.domains || opts.domains.includes(d.id)));
  if (tailoring.tools === "unknown" && needsAgent) {
    try {
      const tools = await probeTools(plainClient, opts.signal);
      tailoring = tailorFor(model, opts.spec, { ...opts.tailor, tools });
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  const suite = generateSuite(opts.spec, { project: opts.project, tailoring, domains: opts.domains });
  await opts.onSuite?.(model, suite);
  const spec = specForModel(opts.spec, model, tailoring);
  const client = makeClient({ maxOutputTokens: tailoring.maxOutputTokens });
  const work: { item: LabItem; sample: number }[] = [];
  for (const d of suite.domains) for (const item of d.items) for (let s = 0; s < samples; s++) work.push({ item, sample: s });
  const total = work.length;
  emit(opts, { type: "model_start", key, model: model.id, tailoring, total });

  const results: ItemResult[] = [];
  const skippedDomains = new Map<DomainId, string>();
  let status: ModelRun["status"] = "done";
  let error: string | undefined;
  let done = 0;
  for (const w of work) {
    if (opts.signal?.aborted) {
      status = "stopped";
      break;
    }
    if (skippedDomains.has(w.item.domain)) {
      done++;
      continue;
    }
    try {
      const r = await runItem(w.item, w.sample, {
        opts,
        model,
        spec,
        client,
        makeClient: (o) => makeClient({ maxOutputTokens: tailoring.maxOutputTokens, ...o }),
        t: tailoring,
        temperature,
      });
      results.push(r);
      done++;
      emit(opts, { type: "item", key, result: r, done, total });
    } catch (err) {
      if (opts.signal?.aborted || (err as Error)?.name === "AbortError") {
        status = "stopped";
        break;
      }
      if (err instanceof LocalModelError && err.kind === "no_tools") {
        // The server refused tools mid-run: every tool domain is not applicable for this model.
        tailoring = { ...tailoring, tools: false, notes: [...tailoring.notes, err.message] };
        for (const d of DOMAINS) if (d.needsTools) skippedDomains.set(d.id, "The model has no tool calling on this server.");
        done++;
        continue;
      }
      status = "failed";
      error = (err as Error).message;
      break;
    }
  }

  const domains = suite.domains.map((d) => scoreDomain(d, results, skippedDomains.get(d.id)));
  const caps = domains.filter((d) => d.area === "capability" && d.status === "ran");
  const outTokens = results.reduce((a, r) => a + r.outputTokens, 0);
  const genMs = results.reduce((a, r) => a + r.ms, 0);
  const run: ModelRun = {
    model,
    tailoring,
    status,
    error,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    domains,
    capabilityScore: caps.length ? caps.reduce((a, d) => a + d.rate, 0) / caps.length : undefined,
    capabilityCoverage: { ran: caps.length, total: domains.filter((d) => d.area === "capability").length },
    alerts: domains.filter((d) => d.alert).length,
    tokensPerSecond: genMs > 0 && outTokens > 0 ? outTokens / (genMs / 1000) : undefined,
    results,
  };
  const { results: _r, ...summary } = run;
  emit(opts, { type: "model_done", key, run: summary });
  return run;
}

export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}-${randomBytes(2).toString("hex")}`;
}

/** Run the lab across models, one model at a time (they usually share one GPU). */
export async function runLab(opts: LabRunOptions): Promise<LabRun> {
  const samples = Math.max(1, Math.floor(opts.samples ?? 1));
  const run: LabRun = {
    version: 1,
    id: newRunId(),
    project: opts.project,
    harness: opts.spec.name,
    startedAt: new Date().toISOString(),
    samples,
    temperature: opts.temperature ?? (samples > 1 ? 0.7 : 0),
    models: [],
  };
  for (const m of opts.models) {
    if (opts.signal?.aborted) break;
    run.models.push(await runModel(m, opts));
  }
  run.finishedAt = new Date().toISOString();
  return run;
}

export { countItems };
