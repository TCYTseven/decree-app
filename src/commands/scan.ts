import * as p from "@clack/prompts";
import type { Command } from "commander";
import { projectPaths, saveProfile } from "../core/config.js";
import { scanProject } from "../scanner/index.js";
import { banner } from "../ui/banner.js";
import { log } from "../ui/logger.js";
import { displayPath } from "../ui/format.js";
import { c, sym } from "../ui/theme.js";
import { rootFor, selfCommand } from "./context.js";
import { isEmptyProfile, profileSummary, scanStep } from "./pipeline.js";

export async function scanCommand(dir: string | undefined, opts: { json?: boolean }, cmd: Command): Promise<void> {
  const root = rootFor(cmd, dir);
  if (opts.json) {
    const profile = await scanProject(root);
    await saveProfile(root, profile);
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }
  p.intro(banner("scan"));
  const profile = await scanStep(root);
  if (isEmptyProfile(profile)) {
    log.warn(`Nothing to scan: no code, APIs or scripts found in ${displayPath(root) === "." ? "this directory" : displayPath(root)}.`);
  } else {
    log.note(profileSummary(profile), `Found in ${profile.name}`);
  }
  if (profile.apis.length) {
    const shown = profile.apis.slice(0, 12).map((a) => `${c.cyan(a.method.padEnd(6))} ${a.path} ${c.dim(a.source)}`);
    if (profile.apis.length > 12) shown.push(c.dim(`… and ${profile.apis.length - 12} more`));
    log.message(shown.join("\n"));
  }
  p.outro(`Saved ${c.bold(displayPath(projectPaths(root).profilePath))} ${sym.dot} next: ${c.cyan(`${selfCommand()} plan`)}`);
}
