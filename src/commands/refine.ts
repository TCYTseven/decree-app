import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessSpec } from "../core/types.js";
import { loadProfile, loadSpec, saveSpec } from "../core/config.js";
import { refineHarness } from "../planner/index.js";
import { validateSpec } from "../core/spec.js";
import { MissingApiKeyError } from "../llm/client.js";
import { DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { banner } from "../ui/banner.js";
import { CliError } from "../ui/errors.js";
import { log } from "../ui/logger.js";
import { withSpinner } from "../ui/spinner.js";
import { c, sym } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { findApiKey, generateStep, makeLLM, safetyBadge, usageLine } from "./pipeline.js";

export interface RefineCmdOptions {
  model?: string;
  apiKey?: string;
  out?: string;
  generate?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: { name: string; fields: string[] }[];
  subagents: { added: string[]; removed: string[]; changed: string[] };
  evals: { before: number; after: number };
  other: string[]; // top-level sections that changed
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffSpecs(before: HarnessSpec, after: HarnessSpec): SpecDiff {
  const bt = new Map(before.tools.map((t) => [t.name, t]));
  const at = new Map(after.tools.map((t) => [t.name, t]));
  const changed: SpecDiff["changed"] = [];
  for (const [name, t] of at) {
    const old = bt.get(name);
    if (!old || same(old, t)) continue;
    const keys = new Set([...Object.keys(old), ...Object.keys(t)]);
    const fields = [...keys].filter((k) => !same((old as unknown as Record<string, unknown>)[k], (t as unknown as Record<string, unknown>)[k]));
    changed.push({ name, fields });
  }
  const bs = new Map(before.subagents.map((s) => [s.name, s]));
  const as = new Map(after.subagents.map((s) => [s.name, s]));
  const other: string[] = [];
  for (const k of ["systemPrompt", "model", "guardrails", "context", "env", "targets", "goal", "description"] as const) {
    if (!same(before[k], after[k])) other.push(k);
  }
  return {
    added: [...at.keys()].filter((n) => !bt.has(n)),
    removed: [...bt.keys()].filter((n) => !at.has(n)),
    changed,
    subagents: {
      added: [...as.keys()].filter((n) => !bs.has(n)),
      removed: [...bs.keys()].filter((n) => !as.has(n)),
      changed: [...as.keys()].filter((n) => bs.has(n) && !same(bs.get(n), as.get(n))),
    },
    evals: { before: before.evals.length, after: after.evals.length },
    other,
  };
}

export function renderDiff(d: SpecDiff, after: HarnessSpec): string {
  const lines: string[] = [];
  const tool = (n: string) => after.tools.find((t) => t.name === n);
  for (const n of d.added) {
    const t = tool(n);
    lines.push(`${c.green("+")} ${c.bold(n)} ${t ? `${c.dim(t.kind)} ${safetyBadge(t)}` : ""}`);
  }
  for (const n of d.removed) lines.push(`${c.red("-")} ${c.strikethrough(n)}`);
  for (const ch of d.changed) lines.push(`${c.yellow("~")} ${c.bold(ch.name)} ${c.dim(ch.fields.join(", "))}`);
  for (const n of d.subagents.added) lines.push(`${c.green("+")} subagent ${c.bold(n)}`);
  for (const n of d.subagents.removed) lines.push(`${c.red("-")} subagent ${c.strikethrough(n)}`);
  for (const n of d.subagents.changed) lines.push(`${c.yellow("~")} subagent ${c.bold(n)}`);
  if (d.evals.before !== d.evals.after) lines.push(`${c.yellow("~")} evals ${d.evals.before} ${sym.arrow} ${d.evals.after}`);
  for (const k of d.other) lines.push(`${c.yellow("~")} ${k}`);
  return lines.length ? lines.join("\n") : c.dim("No changes.");
}

export async function refineCommand(feedbackParts: string[], opts: RefineCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const feedback = feedbackParts.join(" ").trim();
  if (!feedback) throw new CliError("Tell decree what to change", { hint: `e.g. decree-harness refine "make every tool read-only"` });
  const { spec } = await loadSpec(root);
  const { key } = await findApiKey(root, opts.apiKey);
  if (!key) throw new MissingApiKeyError();
  p.intro(banner("refine"));
  const llm = makeLLM(key, opts.model);
  const profile = await loadProfile(root);
  log.step(`${c.dim("Feedback")} ${feedback}`);
  const refined = await withSpinner(
    `Refining ${c.bold(spec.displayName)} with Claude…`,
    (spin) => refineHarness(spec, feedback, { llm, profile, onProgress: (m) => spin.message(m) }),
    "Refined",
    "Refinement failed",
  );
  const checked = validateSpec(refined);
  if (!checked.ok) {
    throw new CliError("The refined spec did not validate; decree.json was not changed.", { details: checked.errors });
  }
  for (const w of checked.warnings) log.warn(w);
  const next = checked.spec;
  const diff = diffSpecs(spec, next);
  log.message(renderDiff(diff, next));
  log.info(usageLine(llm, "Refine"));
  if (opts.dryRun) {
    p.outro(`Dry run ${sym.dot} ${SPEC_FILENAME} unchanged`);
    return;
  }
  await saveSpec(root, next);
  log.success(`Updated ${c.bold(SPEC_FILENAME)} ${c.dim("(previous version in .decree/decree.backup.json)")}`);
  if (opts.generate !== false) {
    await generateStep(root, next, { targets: next.targets, outDir: opts.out ?? DEFAULT_OUT_DIR, force: opts.force });
  }
  p.outro("Refined");
}
