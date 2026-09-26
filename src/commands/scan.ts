import path from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { projectPaths, saveProfile } from "../core/config.js";
import { scanProject } from "../scanner/index.js";
import { banner } from "../ui/banner.js";
import { log } from "../ui/logger.js";
import { c } from "../ui/theme.js";
import { rootFor } from "./context.js";
import { profileSummary, scanStep } from "./pipeline.js";

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
  log.note(profileSummary(profile), profile.name);
  if (profile.apis.length) {
    const shown = profile.apis.slice(0, 12).map((a) => `${c.cyan(a.method.padEnd(6))} ${a.path} ${c.dim(a.source)}`);
    if (profile.apis.length > 12) shown.push(c.dim(`… and ${profile.apis.length - 12} more`));
    log.message(shown.join("\n"));
  }
  const rel = path.relative(process.cwd(), projectPaths(root).profilePath);
  p.outro(`Profile saved to ${c.bold(rel)}`);
}
