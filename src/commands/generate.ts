import * as p from "@clack/prompts";
import type { Command } from "commander";
import { loadSpec } from "../core/config.js";
import { DEFAULT_OUT_DIR } from "../version.js";
import { banner } from "../ui/banner.js";
import { log } from "../ui/logger.js";
import { c } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { defaultTargets, generateStep, parseTargets } from "./pipeline.js";

export interface GenerateCmdOptions {
  targets?: string;
  out?: string;
  force?: boolean;
  dryRun?: boolean;
  clean?: boolean;
}

export async function generateCommand(opts: GenerateCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const { spec, warnings } = await loadSpec(root);
  if (opts.targets) parseTargets(opts.targets); // fail fast on typos
  p.intro(banner("generate"));
  for (const w of warnings) log.warn(w);
  const targets = opts.targets ? parseTargets(opts.targets) : spec.targets.length ? spec.targets : defaultTargets();
  log.step(`${c.bold(spec.displayName)} ${c.dim(`› ${targets.join(", ")}`)}`);
  const report = await generateStep(root, spec, {
    targets,
    outDir: opts.out ?? DEFAULT_OUT_DIR,
    force: opts.force,
    dryRun: opts.dryRun,
    clean: opts.clean,
  });
  const changed = report.created.length + report.updated.length + report.removed.length;
  p.outro(opts.dryRun ? "Dry run complete, nothing was written" : changed ? "Generated" : "Everything is up to date");
}
