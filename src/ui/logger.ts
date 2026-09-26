import * as p from "@clack/prompts";
import { c, contentWidth, sym, wrapText } from "./theme.js";

/** Fit a message to the terminal; clack adds the `│  ` gutter to continuation lines. */
const fit = (msg: string) => wrapText(msg, contentWidth());

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
    if (!uiState.quiet) p.log.info(fit(msg));
  },
  step(msg: string) {
    if (!uiState.quiet) p.log.step(fit(msg));
  },
  success(msg: string) {
    if (!uiState.quiet) p.log.success(fit(msg));
  },
  warn(msg: string) {
    if (uiState.quiet) process.stderr.write(`${c.yellow(`${sym.warn} ${msg}`)}\n`);
    else p.log.warn(fit(msg));
  },
  error(msg: string) {
    process.stderr.write(`${c.red(`${sym.fail} ${msg}`)}\n`);
  },
  message(msg: string) {
    if (!uiState.quiet) p.log.message(fit(msg));
  },
  /** Only printed with --verbose, always to stderr. */
  debug(msg: string) {
    if (uiState.verbose) process.stderr.write(`${c.dim(`[debug] ${msg}`)}\n`);
  },
  note(body: string, title?: string) {
    if (!uiState.quiet) p.note(wrapText(body, contentWidth() - 2), title);
  },
  /** Raw line to stdout (no gutter). */
  raw(msg = "") {
    if (!uiState.quiet) process.stdout.write(`${msg}\n`);
  },
};
