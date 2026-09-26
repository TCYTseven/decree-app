import * as p from "@clack/prompts";
import type { Command } from "commander";
import { loadSpec } from "../core/config.js";
import { DEFAULT_OUT_DIR } from "../version.js";
import { banner } from "../ui/banner.js";
import { groupWarnings, plural } from "../ui/format.js";
import { log, setQuiet } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";
import { rootFor, selfCommand } from "./context.js";
import { defaultTargets, generateStep, parseTargets } from "./pipeline.js";

export interface GenerateCmdOptions {
  targets?: string;
  out?: string;
  force?: boolean;
  dryRun?: boolean;
  clean?: boolean;
  json?: boolean;
}

export async function generateCommand(opts: GenerateCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const flagTargets = opts.targets ? parseTargets(opts.targets) : undefined; // fail fast on typos
  const { spec, warnings } = await loadSpec(root);
  if (opts.json) setQuiet(true);
  else p.intro(banner("generate"));
  for (const w of groupWarnings(warnings)) log.warn(w);
  const targets = flagTargets ?? (spec.targets.length ? spec.targets : defaultTargets());
  log.step(`${c.bold(spec.displayName)} ${c.dim(`${sym.arrow} ${targets.join(", ")}`)}`);
  const report = await generateStep(root, spec, {
    targets,
    outDir: opts.out ?? DEFAULT_OUT_DIR,
    force: opts.force,
    dryRun: opts.dryRun,
    clean: opts.clean,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ dryRun: Boolean(opts.dryRun), targets, ...report }, null, 2)}\n`);
    return;
  }
  const changed = report.created.length + report.updated.length + report.removed.length;
  p.outro(
    opts.dryRun
      ? `Dry run complete ${sym.dot} nothing was written`
      : changed
        ? `Generated ${plural(changed, "file")} ${sym.dot} next: ${c.cyan(`${selfCommand()} chat`)}`
        : "Everything is up to date",
  );
}
