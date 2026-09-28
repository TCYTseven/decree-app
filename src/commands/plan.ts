import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { LLM } from "../core/types.js";
import { loadSpec, saveSpec, specExists } from "../core/config.js";
import { SPEC_FILENAME } from "../version.js";
import { banner } from "../ui/banner.js";
import { log } from "../ui/logger.js";
import { askConfirm } from "../ui/prompts.js";
import { displayPath } from "../ui/format.js";
import { c, sym } from "../ui/theme.js";
import { interactive, rootFor, selfCommand } from "./context.js";
import {
  decisionsFoundLine,
  decisionsStep,
  defaultTargets,
  findApiKey,
  makeLLM,
  parseTargets,
  planStep,
  scanStep,
  specSummary,
  suggestGoal,
  usageLine,
} from "./pipeline.js";
import { CancelledError } from "../ui/prompts.js";

export interface PlanCmdOptions {
  goal?: string;
  targets?: string;
  offline?: boolean;
  model?: string;
  critique?: boolean;
  apiKey?: string;
  yes?: boolean;
}

export async function planCommand(dir: string | undefined, opts: PlanCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd, dir);
  const flagTargets = opts.targets ? parseTargets(opts.targets) : undefined; // fail fast on typos
  const self = selfCommand();
  p.intro(banner("plan"));
  const exists = await specExists(root);
  if (exists && interactive(opts)) {
    const ok = await askConfirm({ message: `Overwrite the existing ${SPEC_FILENAME}? (a backup goes to .decree/)`, initialValue: true });
    if (!ok) throw new CancelledError();
  }
  // Keep the decisions the team already confirmed or superseded; add newly found ones.
  const previousDecisions = exists ? await loadSpec(root).then((l) => l.spec.decisions, () => undefined) : undefined;
  const profile = await scanStep(root);
  const goal = opts.goal?.trim() || suggestGoal(profile);
  if (!opts.goal) log.info(`Goal ${c.dim(sym.arrow)} ${goal} ${c.dim("(change it with --goal)")}`);
  const targets = flagTargets ?? defaultTargets(profile);
  let llm: LLM | undefined;
  if (!opts.offline) {
    const { key } = await findApiKey(root, opts.apiKey);
    if (key) llm = makeLLM(key, opts.model);
    else log.warn(`No ANTHROPIC_API_KEY found ${sym.arrow} planning offline with heuristics.`);
  }
  const decisions = await decisionsStep(root, previousDecisions);
  const spec = await planStep(profile, { goal, targets, llm, model: opts.model, critique: opts.critique, decisions });
  log.message(specSummary(spec));
  const found = decisionsFoundLine(decisions, self);
  if (found) log.info(found);
  if (llm) log.info(usageLine(llm));
  const file = await saveSpec(root, spec);
  p.outro(`Wrote ${c.bold(displayPath(file))} ${sym.dot} next: ${c.cyan(`${self} generate`)}`);
}
