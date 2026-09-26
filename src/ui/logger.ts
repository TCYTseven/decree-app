import * as p from "@clack/prompts";
import { c, sym } from "./theme.js";

export const uiState = {
  verbose: false,
  /** Suppress decorative output (e.g. `--json` modes). Errors still go to stderr. */
  quiet: false,
};

export function setVerbose(v: boolean): void {
  uiState.verbose = v;
}

export function setQuiet(q: boolean): void {
  uiState.quiet = q;
}

/** True when both stdin and stdout are TTYs, so prompts and spinners make sense. */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export const log = {
  info(msg: string) {
    if (!uiState.quiet) p.log.info(msg);
  },
  step(msg: string) {
    if (!uiState.quiet) p.log.step(msg);
  },
  success(msg: string) {
    if (!uiState.quiet) p.log.success(msg);
  },
  warn(msg: string) {
    if (uiState.quiet) process.stderr.write(`${c.yellow(`${sym.warn} ${msg}`)}\n`);
    else p.log.warn(msg);
  },
  error(msg: string) {
    process.stderr.write(`${c.red(`${sym.fail} ${msg}`)}\n`);
  },
  message(msg: string) {
    if (!uiState.quiet) p.log.message(msg);
  },
  /** Only printed with --verbose, always to stderr. */
  debug(msg: string) {
    if (uiState.verbose) process.stderr.write(`${c.dim(`[debug] ${msg}`)}\n`);
  },
  note(body: string, title?: string) {
    if (!uiState.quiet) p.note(body, title);
  },
  /** Raw line to stdout (no gutter). */
  raw(msg = "") {
    if (!uiState.quiet) process.stdout.write(`${msg}\n`);
  },
};
