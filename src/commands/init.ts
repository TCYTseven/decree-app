import { promises as fs } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessSpec, LLM, Target } from "../core/types.js";
import { loadSpec, projectPaths, saveSpec, specExists } from "../core/config.js";
import { MissingApiKeyError } from "../llm/client.js";
import { DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { banner } from "../ui/banner.js";
import { CliError } from "../ui/errors.js";
import { log } from "../ui/logger.js";
import { displayPath } from "../ui/format.js";
import { askConfirm, askMultiselect, askSelect, askText } from "../ui/prompts.js";
import { c, sym } from "../ui/theme.js";
import { interactive, rootFor } from "./context.js";
import {
  ALL_TARGETS,
  defaultTargets,
  findApiKey,
  generateStep,
  makeLLM,
  parseTargets,
  planStep,
  profileSummary,
  scanStep,
  specSummary,
  suggestGoal,
  TARGET_INFO,
  usageLine,
} from "./pipeline.js";

export interface InitOptions {
  goal?: string;
  targets?: string;
  offline?: boolean;
  model?: string;
  out?: string;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  critique?: boolean;
  apiKey?: string;
}

async function assertDir(root: string): Promise<void> {
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new CliError(`${root} is not a directory`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const base = path.basename(root);
      const looksLikeCommand = /^[a-z][a-z-]*$/.test(base);
      throw new CliError(
        looksLikeCommand ? `"${base}" is not a command or a directory` : `Directory not found: ${root}`,
        { hint: looksLikeCommand ? "Run `decree-harness --help` to see the commands." : "Pass the project directory, e.g. `npx decree-harness init ./my-app`." },
      );
    }
    throw err;
  }
}

/** Pick a planner: Claude when a key resolves, otherwise offer the heuristic planner. */
async function choosePlanner(root: string, opts: InitOptions, ask: boolean): Promise<LLM | undefined> {
  if (opts.offline) return undefined;
  const { key, source } = await findApiKey(root, opts.apiKey);
  if (key) {
    log.info(`Using Claude to design the harness ${c.dim(`(API key from ${source})`)}`);
    return makeLLM(key, opts.model);
  }
  const how = [
    `Claude designs much better harnesses than the offline heuristics.`,
    `To use it, set an API key and re-run:`,
    ``,
    `  ${c.cyan("export ANTHROPIC_API_KEY=sk-ant-...")}`,
    `  ${c.dim("or add ANTHROPIC_API_KEY=... to .env, or pass --api-key")}`,
    ``,
    c.dim("Get a key at https://platform.claude.com/settings/keys"),
  ].join("\n");
  if (!ask) {
    log.warn(`No ANTHROPIC_API_KEY found ${sym.arrow} continuing with the offline heuristic planner.`);
    return undefined;
  }
  log.note(how, "No Anthropic API key found");
  const go = await askConfirm({ message: "Continue offline with the heuristic planner?", initialValue: true });
  if (!go) throw new MissingApiKeyError();
  return undefined;
}

export async function initCommand(dir: string | undefined, opts: InitOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd, dir);
  const ask = interactive(opts);
  const outDir = opts.out ?? DEFAULT_OUT_DIR;
  const started = Date.now();

  await assertDir(root);
  p.intro(banner());
  const rel = displayPath(root);
  log.step(`Project ${c.bold(path.basename(root))} ${c.dim(rel === "." ? "(current directory)" : rel)}`);

  // Existing decree.json: re-plan, or just regenerate?
  let spec: HarnessSpec | undefined;
  let llm: LLM | undefined;
  let previousTargets: Target[] | undefined;
  if (await specExists(root)) {
    previousTargets = await loadSpec(root).then((l) => l.spec.targets, () => undefined);
    let mode: "regenerate" | "replan";
    if (ask) {
      mode = await askSelect<"regenerate" | "replan">({
        message: `${SPEC_FILENAME} already exists. What should decree do?`,
        options: [
          { value: "regenerate", label: "Regenerate code from the existing decree.json", hint: "keeps your edits" },
          { value: "replan", label: "Re-plan from scratch", hint: "rescans and overwrites decree.json (a backup is kept)" },
        ],
        initialValue: "regenerate",
      });
    } else {
      mode = opts.force ? "replan" : "regenerate";
      log.info(
        mode === "regenerate"
          ? `Found ${SPEC_FILENAME} ${sym.arrow} regenerating from it ${c.dim("(use --force to re-plan)")}`
          : `Found ${SPEC_FILENAME} ${sym.arrow} re-planning because of --force`,
      );
    }
    if (mode === "regenerate") {
      const loaded = await loadSpec(root);
      for (const w of loaded.warnings) log.warn(w);
      spec = loaded.spec;
    }
  }

  let targets: Target[];
  if (!spec) {
    const profile = await scanStep(root, { save: !opts.dryRun });
    log.note(profileSummary(profile), `${profile.name}`);

    // Goal
    const suggestion = suggestGoal(profile);
    let goal = opts.goal?.trim();
    if (!goal) {
      if (ask) {
        goal = (
          await askText({
            message: "What should this agent do?",
            placeholder: suggestion,
            defaultValue: suggestion,
          })
        ).trim();
      } else {
        goal = suggestion;
        log.info(`Goal ${c.dim(sym.arrow)} ${goal}`);
      }
    }

    // Targets
    if (opts.targets) {
      targets = parseTargets(opts.targets);
    } else if (ask) {
      targets = await askMultiselect<Target>({
        message: "Which targets should decree generate?",
        options: ALL_TARGETS.map((t) => ({ value: t, label: TARGET_INFO[t].label, hint: TARGET_INFO[t].hint })),
        initialValues: previousTargets?.length ? previousTargets : defaultTargets(profile),
        required: true,
      });
    } else {
      targets = previousTargets?.length ? previousTargets : defaultTargets(profile);
      log.info(`Targets ${c.dim(sym.arrow)} ${targets.join(", ")}`);
    }

    // Planner
    llm = await choosePlanner(root, opts, ask);
    spec = await planStep(profile, { goal, targets, llm, model: opts.model, critique: opts.critique });
    log.message(specSummary(spec));
    if (llm) log.info(usageLine(llm));

    if (opts.dryRun) {
      log.info(`${c.dim("(dry run)")} would write ${SPEC_FILENAME}`);
    } else {
      await saveSpec(root, spec);
      log.success(`Wrote ${c.bold(SPEC_FILENAME)} ${c.dim(`${sym.dot} edit it any time, then run`)} ${c.cyan("npx decree-harness generate")}`);
    }
  } else {
    targets = opts.targets ? parseTargets(opts.targets) : spec.targets.length ? spec.targets : defaultTargets();
    log.message(specSummary(spec));
  }

  // Generate
  await generateStep(root, spec, { targets, outDir, force: opts.force, dryRun: opts.dryRun });

  // Next steps
  const outRel = path.relative(root, projectPaths(root, outDir).outDir) || ".";
  const q = (x: string) => (/[\s'"$]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x);
  const inOut = (t: string) => q(path.join(outRel, t));
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
  const cmds: [string, string][] = [];
  if (rel !== ".") cmds.push([`cd ${q(rel)}`, ""]);
  cmds.push([`npx decree-harness chat`, "talk to your agent right now"]);
  if (targets.includes("typescript")) cmds.push([`cd ${inOut("typescript")} && npm i && npm start`, "run the generated agent"]);
  else if (targets.includes("python")) cmds.push([`cd ${inOut("python")} && pip install -e . && python -m ${spec.name.replace(/-/g, "_")}`, "run the generated agent"]);
  cmds.push([`npx decree-harness eval`, `run the ${spec.evals.length} evals`]);
  cmds.push([`npx decree-harness refine "…"`, "change the design in plain English"]);
  const w = Math.min(56, Math.max(...cmds.filter(([, d]) => d).map(([x]) => x.length)) + 2);
  const steps = cmds.map(([x, d]) => (d ? `${c.cyan(pad(x, w))}${c.dim(d)}` : c.cyan(x)));
  if (!llm && spec.provenance.generator === "heuristic") {
    steps.push(c.dim(`Tip: set ANTHROPIC_API_KEY and run \`decree-harness init --force\` for a Claude-designed harness.`));
  }
  log.note(steps.join("\n"), "Next steps");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  p.outro(opts.dryRun ? `Dry run complete ${c.dim(`in ${secs}s`)} ${sym.dot} nothing was written` : `Your harness is ready ${c.dim(`in ${secs}s`)}`);
}
