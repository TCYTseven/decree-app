import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Decision, DecisionStatus, HarnessSpec } from "../core/types.js";
import { loadSpec, projectPaths, saveSpec, specExists } from "../core/config.js";
import { extractDecisions } from "../decisions/extract.js";
import { mergeDecisions, type MissingDecision } from "../decisions/merge.js";
import { rankDecisions, runGetDecisions } from "../decisions/scope.js";
import { withDecisions } from "../decisions/tool.js";
import { DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { CliError } from "../ui/errors.js";
import { closest, groupWarnings, plural } from "../ui/format.js";
import { log, setQuiet } from "../ui/logger.js";
import { renderTable } from "../ui/table.js";
import { c, sym, termWidth, visibleWidth, wrapText } from "../ui/theme.js";
import { rootFor, selfCommand } from "./context.js";
import { generateStep } from "./pipeline.js";

const STATUSES: DecisionStatus[] = ["live", "proposed", "superseded"];

export function statusLabel(s: DecisionStatus): string {
  return s === "live" ? c.green(s) : s === "proposed" ? c.yellow(s) : c.dim(s);
}

/** "12 decisions: 4 live, 8 proposed" (statuses with zero decisions are left out). */
export function decisionCounts(decisions: Decision[]): string {
  const parts = STATUSES.map((s) => [s, decisions.filter((d) => d.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return `${plural(decisions.length, "decision")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * The decisions table: id, status, governs and source. `marks` adds a note after the status (new, missing).
 * Governs and Source drop out on narrow terminals before the id is truncated.
 */
export function decisionsTable(decisions: Decision[], opts: { width?: number; marks?: Map<string, string> } = {}): string {
  const width = opts.width ?? termWidth();
  // Ids are what the other commands take: keep them whole when the terminal allows; governs and source give way.
  const longest = Math.max(8, ...decisions.map((d) => d.id.length));
  const status = Math.max(6, ...decisions.map((d) => d.status.length + (opts.marks?.has(d.id) ? visibleWidth(opts.marks.get(d.id)!) + 1 : 0)));
  const cols = [
    { header: "Decision", min: Math.min(longest, Math.max(14, width - 40 - status)) },
    { header: "Status", min: status },
    { header: "Governs", min: 8, max: 32, hideBelow: 72 },
    { header: "Source", min: 10, max: 40, hideBelow: 96 },
  ];
  const rows = decisions.map((d) => {
    const mark = opts.marks?.get(d.id);
    return [
      c.bold(d.id),
      `${statusLabel(d.status)}${mark ? ` ${mark}` : ""}`,
      d.governs.join(", "),
      c.dim(d.source),
    ];
  });
  return renderTable(cols, rows, { width });
}

async function load(root: string): Promise<{ spec: HarnessSpec; warnings: string[] }> {
  if (!(await specExists(root))) {
    throw new CliError(`No ${SPEC_FILENAME} here yet`, { hint: `Run \`${selfCommand()} init\` first; it extracts decisions as part of setup.` });
  }
  return loadSpec(root);
}

function findDecision(spec: HarnessSpec, id: string): Decision {
  const list = spec.decisions ?? [];
  const d = list.find((x) => x.id === id);
  if (d) return d;
  const guess = closest(id, list.map((x) => x.id));
  throw new CliError(`No decision with id "${id}"`, {
    hint: guess ? `Did you mean ${c.bold(guess)}?` : `Run \`${selfCommand()} decisions\` to see the ids.`,
  });
}

interface MutateOptions {
  generate?: boolean;
  out?: string;
  force?: boolean;
}

/**
 * Save the spec (adding get_decisions when it now has decisions), then regenerate when the harness was generated
 * before, like `refine` does. Otherwise say how to regenerate.
 */
async function save(root: string, spec: HarnessSpec, opts: MutateOptions): Promise<void> {
  const next = withDecisions(spec);
  await saveSpec(root, next);
  const outDir = opts.out ?? DEFAULT_OUT_DIR;
  const generatedBefore = existsSync(projectPaths(root, outDir).manifestPath);
  if (opts.generate !== false && generatedBefore) {
    await generateStep(root, next, { targets: next.targets, outDir, force: opts.force });
    return;
  }
  log.raw(c.dim(`Run \`${selfCommand()} generate\` to update the generated agent.`));
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function decisionsListCommand(opts: { status?: string; json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (opts.status && !STATUSES.includes(opts.status as DecisionStatus)) {
    throw new CliError(`Unknown status "${opts.status}"`, { hint: `Use one of: ${STATUSES.join(", ")}` });
  }
  const { spec, warnings } = await load(root);
  const all = spec.decisions ?? [];
  const list = opts.status ? all.filter((d) => d.status === opts.status) : all;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }
  const width = termWidth();
  for (const w of groupWarnings(warnings)) log.warn(w);
  if (!all.length) {
    log.raw(wrapText(`No decisions in ${SPEC_FILENAME} yet. Run \`${selfCommand()} decisions extract\` to pull them from your ADRs, CLAUDE.md/AGENTS.md rules and post-mortems.`, width));
    return;
  }
  log.raw(wrapText(`${c.bold(spec.displayName)} ${c.dim(`${sym.dot} ${decisionCounts(all)}`)}`, width));
  if (!list.length) {
    log.raw(c.dim(`No ${opts.status} decisions.`));
    return;
  }
  log.raw(decisionsTable(list, { width }));
  if (list.some((d) => d.status === "proposed")) {
    log.raw(wrapText(c.dim(`Proposed decisions are not served to the agent. Confirm the ones that hold with \`${selfCommand()} decisions confirm <id>\`.`), width));
  }
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

function missingNote(m: MissingDecision): string {
  return m.reason === "file-gone" ? "source file is gone" : "no longer found in its source";
}

export async function decisionsExtractCommand(opts: MutateOptions & { dryRun?: boolean; json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const hasSpec = await specExists(root);
  if (!hasSpec && !opts.dryRun && !opts.json) {
    throw new CliError(`No ${SPEC_FILENAME} here yet`, { hint: `Run \`${selfCommand()} init\` (it extracts decisions too), or preview with \`${selfCommand()} decisions extract --dry-run\`.` });
  }
  const loaded = hasSpec ? await loadSpec(root) : undefined;
  const { decisions: extracted, sources } = await extractDecisions(root);
  const merged = mergeDecisions(loaded?.spec.decisions ?? [], extracted, (f) => existsSync(path.join(root, f)));
  const changed = JSON.stringify(merged.decisions) !== JSON.stringify(loaded?.spec.decisions ?? []);
  const write = !!loaded && !opts.dryRun && changed;
  if (opts.json) {
    setQuiet(true);
    if (write) await save(root, { ...loaded!.spec, decisions: merged.decisions }, { ...opts, generate: false });
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: Boolean(opts.dryRun) || !loaded,
          sources,
          added: merged.added.map((d) => d.id),
          missing: merged.missing.map((m) => ({ id: m.decision.id, reason: m.reason })),
          decisions: merged.decisions,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const width = termWidth();
  if (!merged.decisions.length) {
    log.raw(
      wrapText(
        `No decisions found in ${plural(sources.length, "file")}. decree reads ADRs (docs/adr, docs/decisions, adr/), CLAUDE.md, AGENTS.md, .cursor/rules, Copilot instructions and post-mortems (docs/postmortems, incidents/).`,
        width,
      ),
    );
    return;
  }
  const marks = new Map<string, string>();
  for (const d of merged.added) marks.set(d.id, c.cyan("new"));
  for (const m of merged.missing) marks.set(m.decision.id, c.red("missing"));
  log.raw(wrapText(`Read ${plural(sources.length, "file")} ${c.dim(sym.dot)} ${decisionCounts(merged.decisions)} ${c.dim(sym.dot)} ${merged.added.length} new`, width));
  log.raw(decisionsTable(merged.decisions, { width, marks }));
  if (merged.missing.length) {
    log.raw(
      wrapText(
        c.yellow(`${sym.warn} ${plural(merged.missing.length, "decision")} could not be found in ${merged.missing.length === 1 ? "its source" : "their sources"} anymore. They are kept; supersede them with \`${selfCommand()} decisions supersede <id>\` if they no longer apply.`),
        width,
      ),
    );
    for (const m of merged.missing) log.raw(wrapText(`  ${m.decision.id} ${c.dim(`(${missingNote(m)}: ${m.decision.source})`)}`, width, "    "));
  }
  if (opts.dryRun || !loaded) {
    log.raw(c.dim(`Dry run: ${SPEC_FILENAME} was not changed.`));
    return;
  }
  const proposed = merged.decisions.filter((d) => d.status === "proposed").length;
  if (proposed) log.raw(wrapText(c.dim(`${plural(proposed, "proposed decision")} ${proposed === 1 ? "is" : "are"} not served until confirmed: \`${selfCommand()} decisions confirm <id>\`.`), width));
  if (!write) {
    log.raw(c.dim(`${SPEC_FILENAME} is up to date.`));
    return;
  }
  log.raw(`${c.green(sym.ok)} Updated ${c.bold(SPEC_FILENAME)}`);
  await save(root, { ...loaded!.spec, decisions: merged.decisions }, opts);
}

// ---------------------------------------------------------------------------
// for
// ---------------------------------------------------------------------------

export async function decisionsForCommand(paths: string[], opts: { proposed?: boolean; json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec } = await load(root);
  const decisions = spec.decisions ?? [];
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(rankDecisions(decisions, paths, { includeProposed: opts.proposed }).slice(0, 8), null, 2)}\n`);
    return;
  }
  const result = runGetDecisions(decisions, { paths, include_proposed: Boolean(opts.proposed) }, root);
  log.raw(c.dim(`get_decisions ${JSON.stringify({ paths, ...(opts.proposed ? { include_proposed: true } : {}) })}`));
  log.raw(result.output);
}

// ---------------------------------------------------------------------------
// confirm / supersede
// ---------------------------------------------------------------------------

export async function decisionsConfirmCommand(ids: string[], opts: MutateOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec } = await load(root);
  const targets = ids.map((id) => findDecision(spec, id));
  const changed = new Set<string>();
  for (const d of targets) {
    if (d.status === "live") {
      log.raw(c.dim(`${d.id} is already live.`));
      continue;
    }
    changed.add(d.id);
    log.raw(`${c.green(sym.ok)} ${c.bold(d.id)} ${statusLabel(d.status)} ${sym.arrow} ${statusLabel("live")}${d.status === "superseded" ? c.dim(" (reinstated)") : ""}`);
  }
  if (!changed.size) return;
  const decisions = (spec.decisions ?? []).map((d) => {
    if (!changed.has(d.id)) return d;
    const { supersededBy: _drop, ...rest } = d;
    return { ...rest, status: "live" as const };
  });
  await save(root, { ...spec, decisions }, opts);
}

export async function decisionsSupersedeCommand(id: string, opts: MutateOptions & { by?: string }, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec } = await load(root);
  const d = findDecision(spec, id);
  if (opts.by !== undefined) {
    if (opts.by === id) throw new CliError("A decision cannot supersede itself");
    const by = findDecision(spec, opts.by);
    if (by.status === "superseded") log.warn(`${by.id} is itself superseded.`);
  }
  if (d.status === "superseded" && d.supersededBy === opts.by) {
    log.raw(c.dim(`${d.id} is already superseded${opts.by ? ` by ${opts.by}` : ""}.`));
    return;
  }
  const decisions = (spec.decisions ?? []).map((x) => {
    if (x.id !== id) return x;
    const { supersededBy: _drop, ...rest } = x;
    return { ...rest, status: "superseded" as const, ...(opts.by ? { supersededBy: opts.by } : {}) };
  });
  log.raw(`${c.green(sym.ok)} ${c.bold(d.id)} ${statusLabel(d.status)} ${sym.arrow} ${statusLabel("superseded")}${opts.by ? ` by ${c.bold(opts.by)}` : ""}`);
  await save(root, { ...spec, decisions }, opts);
}
