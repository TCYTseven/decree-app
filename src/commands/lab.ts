import path from "node:path";
import type { Command } from "commander";
import type { HarnessSpec } from "../core/types.js";
import { loadSpec, SpecNotFoundError } from "../core/config.js";
import { extractDecisions } from "../decisions/extract.js";
import { detectLocalModels, selectModels, type DetectedServer, type LocalModel } from "../lab/endpoints.js";
import { failureLines, modelCard, modelsTable, suiteOutline } from "../lab/report.js";
import { runLab } from "../lab/run.js";
import { startLabServer } from "../lab/server.js";
import { saveRun, saveSuite } from "../lab/store.js";
import { countItems, DOMAINS, generateSuite, tailorFor } from "../lab/suite.js";
import type { DomainId, LabEvent } from "../lab/types.js";
import { planHarness } from "../planner/index.js";
import { isLoopbackHost, isWildcardHost } from "../preview/security.js";
import { scanProject } from "../scanner/index.js";
import { banner } from "../ui/banner.js";
import { CliError, SilentExit } from "../ui/errors.js";
import { formatDuration, plural } from "../ui/format.js";
import { log, setQuiet } from "../ui/logger.js";
import { createSpinner } from "../ui/spinner.js";
import { c, sym, termWidth } from "../ui/theme.js";
import { CACHE_DIRNAME } from "../version.js";
import { rootFor, selfCommand } from "./context.js";
import { defaultTargets, suggestGoal } from "./pipeline.js";
import { openBrowser } from "./preview.js";

export interface LabCmdOptions {
  endpoint?: string[];
  models?: string;
  samples?: string;
  domains?: string;
  maxContext?: string;
  temperature?: string;
  timeout?: string;
  port?: string;
  host?: string;
  open?: boolean;
  json?: boolean;
  failOnAlert?: boolean;
}

export const DEFAULT_LAB_PORT = 4322;

/** decree.json when there is one; otherwise an offline plan from a scan, held in memory (nothing is written). */
export async function labSpec(root: string): Promise<{ spec: HarnessSpec; source: "decree.json" | "scan"; warnings: string[] }> {
  try {
    const { spec, warnings } = await loadSpec(root);
    return { spec, source: "decree.json", warnings };
  } catch (err) {
    if (!(err instanceof SpecNotFoundError)) throw err;
  }
  const profile = await scanProject(root);
  const { decisions } = await extractDecisions(root);
  const spec = await planHarness(profile, { goal: suggestGoal(profile), targets: defaultTargets(profile), decisions });
  return { spec, source: "scan", warnings: [] };
}

function localApiKey(): string | undefined {
  return process.env.DECREE_LOCAL_API_KEY?.trim() || undefined;
}

function int(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new CliError(`--${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  return n;
}

export function parseDomains(raw?: string): DomainId[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = new Set<string>(DOMAINS.map((d) => d.id));
  const out: DomainId[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === "capability" || part === "safety") {
      for (const d of DOMAINS) if (d.area === part && !out.includes(d.id)) out.push(d.id);
      continue;
    }
    if (!ids.has(part)) throw new CliError(`Unknown eval domain "${part}"`, { hint: `Domains: ${[...ids].join(", ")} (or capability, safety)` });
    if (!out.includes(part as DomainId)) out.push(part as DomainId);
  }
  return out;
}

async function detect(opts: LabCmdOptions, quiet: boolean): Promise<DetectedServer[]> {
  const spin = quiet ? undefined : createSpinner();
  spin?.start("Looking for local models (Ollama, LM Studio, llama.cpp, vLLM, Jan…)");
  const servers = await detectLocalModels({ endpoints: opts.endpoint, apiKey: localApiKey() });
  const n = servers.reduce((a, s) => a + s.models.length, 0);
  spin?.stop(n ? `Found ${plural(n, "local model")} on ${plural(servers.filter((s) => s.models.length).length, "server")}` : "No local models found");
  return servers;
}

function noModelsError(): CliError {
  return new CliError("No local models found", {
    hint: "Start one (`ollama serve` then `ollama pull qwen3:8b`, or LM Studio's local server) and try again. For other servers pass --endpoint http://host:port.",
  });
}

// ---------------------------------------------------------------------------
// lab (dashboard)
// ---------------------------------------------------------------------------

export async function labServeCommand(opts: LabCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const host = (opts.host ?? "127.0.0.1").trim();
  const port = opts.port === undefined ? DEFAULT_LAB_PORT : int("port", opts.port, 0, 65535)!;
  const maxContext = int("max-context", opts.maxContext, 2048, 1_048_576);
  const out = (s = "") => process.stdout.write(`${s}\n`);
  out();
  out(banner("lab"));
  const servers = await detect(opts, false);
  let server;
  try {
    server = await startLabServer({
      root,
      host,
      port,
      maxContext,
      apiKey: localApiKey(),
      detect: { endpoints: opts.endpoint, apiKey: localApiKey() },
      initial: servers,
      deps: { loadSpec: () => labSpec(root) },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND") throw new CliError(`Cannot listen on ${host}`, { hint: "Use --host 127.0.0.1 (the default)." });
    if (code === "EACCES") throw new CliError(`No permission to listen on port ${port}`, { hint: "Pick a port above 1024." });
    throw err;
  }
  const models = servers.flatMap((s) => s.models);
  out();
  out(`  ${c.green(sym.ok)} ${c.bold("Lab ready")}  ${c.cyan(c.underline(server.url))}`);
  if (server.portFallback) out(`  ${c.dim(`Port ${port} was busy, so a free port was picked.`)}`);
  if (models.length) out(`  ${c.dim(`${plural(models.length, "model")}: ${models.slice(0, 6).map((m) => m.id).join(", ")}${models.length > 6 ? ", …" : ""}`)}`);
  else out(`  ${c.yellow(`${sym.warn} No local models yet. Start Ollama or LM Studio and press Refresh on the page.`)}`);
  if (!isLoopbackHost(host)) out(`  ${c.yellow(`${sym.warn} Listening on ${isWildcardHost(host) ? "all interfaces" : host}. Anyone who can reach it can run models on this machine.`)}`);
  out(`  ${c.dim(`Runs are saved in ${CACHE_DIRNAME}/lab/ · Ctrl+C to stop`)}`);
  out();
  if (opts.open !== false) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  out();
  out(c.dim("Stopping lab…"));
  await server.close();
}

// ---------------------------------------------------------------------------
// lab models
// ---------------------------------------------------------------------------

export async function labModelsCommand(opts: LabCmdOptions, _cmd: Command): Promise<void> {
  if (opts.json) setQuiet(true);
  const servers = await detect(opts, !!opts.json);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ servers }, null, 2)}\n`);
    return;
  }
  if (!servers.some((s) => s.models.length || s.error)) throw noModelsError();
  log.message(modelsTable(servers, termWidth() - 4));
}

// ---------------------------------------------------------------------------
// lab generate
// ---------------------------------------------------------------------------

export async function labGenerateCommand(opts: LabCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (opts.json) setQuiet(true);
  const { spec, source } = await labSpec(root);
  const servers = await detect(opts, !!opts.json);
  const models = selectModels(servers.flatMap((s) => s.models), opts.models?.split(","));
  const domains = parseDomains(opts.domains);
  const maxContext = int("max-context", opts.maxContext, 2048, 1_048_576);
  const project = path.basename(root);
  const written: { model: string | null; file: string; items: number }[] = [];
  if (!models.length) {
    // No model to fit to: write the generic suite (assumed 4k context, tools unknown).
    const suite = generateSuite(spec, { project, domains });
    const file = await saveSuite(root, { provider: "openai-compatible", id: "generic" }, suite);
    written.push({ model: null, file, items: countItems(suite) });
    if (!opts.json) {
      log.info(`${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${source === "scan" ? "planned from a scan (no decree.json)" : "decree.json"}`)}`);
      log.message(suiteOutline(suite).join("\n"));
    }
  }
  for (const m of models) {
    const suite = generateSuite(spec, { project, domains, tailoring: tailorFor(m, spec, { maxContext }) });
    const file = await saveSuite(root, m, suite);
    written.push({ model: m.id, file, items: countItems(suite) });
    if (!opts.json) {
      log.info(`${c.bold(m.id)} ${c.dim(`${sym.dot} ${m.providerLabel} ${sym.dot} ${plural(countItems(suite), "item")}`)}`);
      log.message(suiteOutline(suite).join("\n"));
      const notes = suite.tailoring?.notes ?? [];
      if (notes.length) log.message(notes.map((n) => c.dim(`  ${sym.dot} ${n}`)).join("\n"));
    }
  }
  if (opts.json) process.stdout.write(`${JSON.stringify({ suites: written.map((w) => ({ ...w, file: path.relative(root, w.file) })) }, null, 2)}\n`);
  else log.success(`Wrote ${plural(written.length, "suite")} to ${CACHE_DIRNAME}/lab/suites/`);
}

// ---------------------------------------------------------------------------
// lab run (terminal)
// ---------------------------------------------------------------------------

export async function labRunCommand(opts: LabCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (opts.json) setQuiet(true);
  const samples = int("samples", opts.samples, 1, 50) ?? 1;
  const maxContext = int("max-context", opts.maxContext, 2048, 1_048_576);
  const timeoutS = int("timeout", opts.timeout, 5, 3600);
  const temperature = opts.temperature === undefined ? undefined : Number(opts.temperature);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new CliError(`--temperature must be between 0 and 2 (got "${opts.temperature}")`);
  const domains = parseDomains(opts.domains);

  if (!opts.json) {
    process.stdout.write("\n");
    log.raw(banner("lab"));
  }
  const { spec, source, warnings } = await labSpec(root);
  if (!opts.json) {
    for (const w of warnings) log.warn(w);
    log.info(`${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${source === "scan" ? `no decree.json, planned from a scan (run \`${selfCommand()} init\` to keep one)` : "decree.json"}`)}`);
  }
  const servers = await detect(opts, !!opts.json);
  const all = servers.flatMap((s) => s.models);
  if (!all.length) throw noModelsError();
  const models: LocalModel[] = selectModels(all, opts.models?.split(","));
  if (!models.length) throw new CliError(`No local model matches "${opts.models}"`, { hint: `Available: ${all.map((m) => m.id).join(", ")}` });

  const spin = opts.json ? undefined : createSpinner();
  const started = Date.now();
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);
  const onEvent = (e: LabEvent) => {
    if (!spin) return;
    if (e.type === "model_start") spin.start(`${e.model}: ${plural(e.total, "trial")}…`);
    else if (e.type === "item") spin.message(`${e.result.id.slice(0, 40)} ${e.result.passed ? c.green(sym.ok) : c.red(sym.fail)}  ${c.dim(`${e.done}/${e.total}`)}`);
    else if (e.type === "model_done") {
      const r = e.run;
      const score = r.capabilityScore === undefined ? "" : ` ${sym.dot} capability ${(r.capabilityScore * 100).toFixed(1)}`;
      if (r.status === "failed") spin.error(`${r.model.id}: ${r.error ?? "failed"}`);
      else spin.stop(`${r.model.id}${c.dim(`${score}${r.alerts ? "" : ` ${sym.dot} no safety alerts`}`)}${r.alerts ? c.red(` ${sym.dot} ${plural(r.alerts, "safety alert")}`) : ""}`);
    }
  };
  let run;
  try {
    run = await runLab({
      projectRoot: root,
      project: path.basename(root),
      spec,
      models,
      samples,
      temperature,
      domains,
      tailor: { maxContext },
      apiKey: localApiKey(),
      timeoutMs: timeoutS ? timeoutS * 1000 : undefined,
      signal: ac.signal,
      onSuite: (m, suite) => saveSuite(root, m, suite).then(() => undefined),
      onEvent,
    });
  } finally {
    process.off("SIGINT", onSigint);
  }
  const file = await saveRun(root, run);
  const alerts = run.models.reduce((a, m) => a + m.alerts, 0);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    log.message(modelCard(run, termWidth() - 4));
    for (const m of run.models) {
      const lines = failureLines(m);
      const notes = m.tailoring.notes.map((n) => c.dim(`  ${sym.dot} ${n}`));
      if (lines.length || notes.length) log.message([c.bold(m.model.id), ...lines, ...notes].join("\n"));
    }
    log.success(`Saved ${path.relative(root, file)} ${c.dim(`${sym.dot} ${formatDuration(Date.now() - started)} ${sym.dot} open \`${selfCommand()} lab\` for the dashboard`)}`);
  }
  if (run.models.some((m) => m.status === "failed")) throw new SilentExit(1);
  if (opts.failOnAlert && alerts) throw new SilentExit(2);
}
