import path from "node:path";
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

/**
 * How the user invoked decree, for commands we print back to them:
 * `decree` (global bin alias), `decree-harness` (global install) or `npx decree-harness`.
 */
export function selfCommand(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const bin = path.basename(argv[1] ?? "").replace(/\.(c|m)?js$/, "");
  const viaNpx = env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(argv[1] ?? "");
  if (viaNpx) return "npx decree-harness";
  if (bin === "decree" || bin === "decree-harness") return bin;
  return "npx decree-harness";
}
