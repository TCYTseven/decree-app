import type { Command } from "commander";
import { resolveProjectRoot } from "../core/config.js";
import { isTTY } from "../ui/logger.js";

export interface GlobalOptions {
  cwd?: string;
  verbose?: boolean;
  color?: boolean;
}

export function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals<GlobalOptions>();
}

/** Project root for a command: `--cwd` joined with an optional positional dir. */
export function rootFor(cmd: Command, dir?: string): string {
  return resolveProjectRoot(globals(cmd).cwd, dir);
}

/** Prompts are allowed only on a real terminal and when --yes wasn't passed. */
export function interactive(opts: { yes?: boolean }): boolean {
  return !opts.yes && isTTY();
}
