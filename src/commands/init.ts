import { promises as fs } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import type { HarnessSpec, LLM, Target } from "../core/types.js";
import { loadSpec, projectPaths, saveProfile, saveSpec, specExists } from "../core/config.js";
import { MissingApiKeyError } from "../llm/client.js";
import { DEFAULT_OUT_DIR, SPEC_FILENAME } from "../version.js";
import { banner } from "../ui/banner.js";
import { CliError } from "../ui/errors.js";
import { log } from "../ui/logger.js";
import { closest, displayPath, groupWarnings, plural } from "../ui/format.js";
import { askConfirm, askMultiselect, askSelect, askText } from "../ui/prompts.js";
import { c, contentWidth, sym, termWidth, wrapText } from "../ui/theme.js";
import { interactive, rootFor, selfCommand } from "./context.js";
import {
  ALL_TARGETS,
  defaultTargets,
  findApiKey,
  generateStep,
  isEmptyProfile,
  makeLLM,
  parseTargets,
  planStep,
  profileSummary,
  renderSteps,
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

async function assertDir(root: string, dir: string | undefined, cmd: Command): Promise<void> {
  const self = selfCommand();
  let st;
  try {
    st = await fs.stat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // `decree genrate` lands here: the default command treats the typo as a directory.
    const word = dir ?? path.basename(root);
    const commands = (cmd.parent?.commands ?? []).flatMap((x) => [x.name(), ...x.aliases()]);
    const guess = /^[a-z][a-z-]*$/.test(word) ? closest(word, commands) : undefined;
    if (guess) throw new CliError(`Unknown command "${word}". Did you mean ${c.bold(guess)}?`, { hint: `Run \`${self} --help\` to see every command.` });
    if (/^[a-z][a-z-]*$/.test(word) && !word.includes("/"))
      throw new CliError(`"${word}" is not a command, and there is no directory by that name`, { hint: `Run \`${self} --help\` to see the commands.` });
    throw new CliError(`Directory not found: ${displayPath(root)}`, { hint: `Pass your project directory, e.g. \`${self} ./my-app\`.` });
  }
  if (!st.isDirectory()) throw new CliError(`${displayPath(root)} is not a directory`, { hint: `Pass your project directory, e.g. \`${self} ./my-app\`.` });
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
    `Claude designs far better harnesses than offline mode.`,
    `To use it, set a key and re-run:`,
    ``,
    `  ${c.cyan("export ANTHROPIC_API_KEY=sk-ant-...")}`,
    `  ${c.dim("(or put it in .env, or pass --api-key)")}`,
    ``,
    c.dim("Get a key: https://platform.claude.com/settings/keys"),
  ].join("\n");
  if (!ask) {
    log.warn(`No ANTHROPIC_API_KEY found ${sym.arrow} planning offline with heuristics.`);
    return undefined;
  }
  log.note(how, "No Anthropic API key found");
  const go = await askConfirm({ message: "Continue offline (heuristic planner)?", initialValue: true });
  if (!go) throw new MissingApiKeyError();
  return undefined;
}

export async function initCommand(dir: string | undefined, opts: InitOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd, dir);
  const ask = interactive(opts);
  const outDir = opts.out ?? DEFAULT_OUT_DIR;
  const started = Date.now();
  const self = selfCommand();
  const flagTargets = opts.targets ? parseTargets(opts.targets) : undefined; // fail fast on typos

  await assertDir(root, dir, cmd);
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
      for (const w of groupWarnings(loaded.warnings)) log.warn(w);
      spec = loaded.spec;
    }
  }

  let targets: Target[];
  if (!spec) {
    const profile = await scanStep(root, { save: false });
    if (isEmptyProfile(profile)) {
      const where = rel === "." ? "this directory" : rel;
      const found =
        profile.stats.files === 0
          ? `${rel === "." ? "This directory" : rel} is empty`
          : `${plural(profile.stats.files, "file")} in ${where}, but no code, APIs or scripts`;
      log.note(
        [
          `decree builds tools from what it finds: API routes, OpenAPI`,
          `specs, scripts, env vars and database models.`,
          ``,
          `With nothing to scan, it can still make a general-purpose`,
          `coding agent (read, list and search files). To scan a real`,
          `project, run decree inside it:`,
          ``,
          `  ${c.cyan(`cd path/to/project && ${self}`)}`,
        ].join("\n"),
        found,
      );
      if (ask) {
        const choice = await askSelect<"general" | "stop">({
          message: "What would you like to do?",
          options: [
            { value: "general", label: "Create a general-purpose coding agent here" },
            { value: "stop", label: "Stop, I'll run decree in my project" },
          ],
          initialValue: "stop",
        });
        if (choice === "stop") {
          p.outro(`Nothing written. Next: ${c.cyan(`cd path/to/project && ${self}`)}`);
          return;
        }
      } else {
        log.info("Continuing with a general-purpose coding agent.");
      }
    } else {
      log.note(profileSummary(profile), `Found in ${profile.name}`);
    }
    if (!opts.dryRun) await saveProfile(root, profile);

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
    if (flagTargets) {
      targets = flagTargets;
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
      log.success(`Wrote ${c.bold(SPEC_FILENAME)} ${c.dim(`${sym.dot} edit it, then run ${self} generate`)}`);
    }
  } else {
    targets = flagTargets ?? (spec.targets.length ? spec.targets : defaultTargets());
    log.message(specSummary(spec));
  }

  // Generate
  await generateStep(root, spec, { targets, outDir, force: opts.force, dryRun: opts.dryRun });

  // Next steps: the commands to run now, in order, then the single best one in the outro.
  const { key } = llm ? { key: "set" } : await findApiKey(root, opts.apiKey);
  const outRel = path.relative(root, projectPaths(root, outDir).outDir) || ".";
  const q = (x: string) => (/[\s'"$]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x);
  const inOut = (t: string) => q(path.join(outRel, t));
  const steps: [string, string][] = [];
  if (rel !== ".") steps.push([`cd ${q(rel)}`, ""]);
  if (!key) steps.push(["export ANTHROPIC_API_KEY=sk-ant-...", "needed to chat, run and eval"]);
  steps.push([`${self} chat`, "talk to your agent"]);
  if (targets.includes("typescript")) steps.push([`cd ${inOut("typescript")} && npm i && npm start`, "run the TypeScript agent"]);
  else if (targets.includes("python"))
    steps.push([`cd ${inOut("python")} && pip install -e . && python -m ${spec.name.replace(/-/g, "_")}`, "run the Python agent"]);
  if (spec.evals.length) steps.push([`${self} eval`, `run the ${plural(spec.evals.length, "eval")}`]);
  steps.push([`${self} refine "..."`, "change it in plain English"]);
  const body = [renderSteps(steps, termWidth() - 8)];
  if (!llm && spec.provenance.generator === "heuristic" && !opts.dryRun) {
    body.push("", c.dim(wrapText(`Planned offline. With a key set, \`${self} init --force\` re-plans with Claude for a much better harness.`, contentWidth() - 6)));
  }
  if (!opts.dryRun) log.note(body.join("\n"), "Next steps");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const cdFirst = rel !== "." ? `cd ${q(rel)} && ` : "";
  const next = key ? c.cyan(`${cdFirst}${self} chat`) : `set ${c.cyan("ANTHROPIC_API_KEY")}, then ${c.cyan(`${cdFirst}${self} chat`)}`;
  p.outro(
    wrapText(
      opts.dryRun
        ? `Dry run complete ${c.dim(`in ${secs}s`)} ${sym.dot} nothing was written`
        : `Ready ${c.dim(`in ${secs}s`)} ${sym.dot} next: ${next}`,
      termWidth() - 3,
      "   ",
    ),
  );
}
