import * as p from "@clack/prompts";
import { formatDuration } from "./format.js";
import { isTTY, log, uiState } from "./logger.js";
import { c, sym } from "./theme.js";

export interface Spinner {
  start(msg: string): void;
  /** Update the live progress message. */
  message(msg: string): void;
  /** Finish successfully; elapsed time is appended automatically. */
  stop(msg: string): void;
  error(msg: string): void;
  elapsedMs(): number;
}

/**
 * A spinner that shows the live message and elapsed time on a TTY, and falls
 * back to plain log lines when output is piped (CI, `| tee`).
 */
export function createSpinner(): Spinner {
  let started = 0;
  let base = "";
  let last = "";
  let timer: NodeJS.Timeout | undefined;
  const live = isTTY() && !uiState.quiet;
  const s = live
    ? p.spinner({
        onCancel: () => {
          process.exitCode = 130;
          process.exit(130);
        },
      })
    : undefined;
  const elapsed = () => (started ? Date.now() - started : 0);
  const render = () => {
    const secs = Math.floor(elapsed() / 1000);
    const detail = last && last !== base ? c.dim(` ${sym.dot} ${last}`) : "";
    s?.message(`${base}${detail}${secs >= 1 ? c.dim(` (${formatDuration(elapsed())})`) : ""}`);
  };
  return {
    start(msg) {
      started = Date.now();
      base = msg;
      last = "";
      if (s) {
        s.start(msg);
        timer = setInterval(render, 1000);
        timer.unref?.();
      } else {
        log.debug(msg);
      }
    },
    message(msg) {
      last = msg;
      if (s) render();
      else log.debug(msg);
    },
    stop(msg) {
      if (timer) clearInterval(timer);
      const text = `${msg} ${c.dim(formatDuration(elapsed()))}`;
      if (s) s.stop(text);
      else log.success(text);
    },
    error(msg) {
      if (timer) clearInterval(timer);
      if (s) s.error(msg);
      else if (!uiState.quiet) p.log.error(msg);
    },
    elapsedMs: elapsed,
  };
}

/** Run `fn` under a spinner; the spinner reports failure if it throws. */
export async function withSpinner<T>(
  startMsg: string,
  fn: (spin: Spinner) => Promise<T>,
  doneMsg: string | ((result: T) => string),
  failMsg = startMsg.replace(/…$/, "") + " failed",
): Promise<T> {
  const spin = createSpinner();
  spin.start(startMsg);
  try {
    const result = await fn(spin);
    spin.stop(typeof doneMsg === "function" ? doneMsg(result) : doneMsg);
    return result;
  } catch (err) {
    spin.error(failMsg);
    throw err;
  }
}
