import { readFileSync } from "node:fs";
import path from "node:path";
import { displayPath } from "./format.js";
import { c, sym, termWidth, wrapText } from "./theme.js";
import { uiState } from "./logger.js";
import { CancelledError } from "./prompts.js";

/** An error with a user-facing hint. Thrown by commands; printed without a stack. */
export class CliError extends Error {
  hint?: string;
  exitCode: number;
  details?: string[];
  constructor(message: string, opts: { hint?: string; exitCode?: number; details?: string[] } = {}) {
    super(message);
    this.name = "CliError";
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? 1;
    this.details = opts.details;
  }
}

/** Exit with a code without printing anything (the command already reported). */
export class SilentExit extends Error {
  constructor(public exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "SilentExit";
  }
}

interface Explained {
  message: string;
  hint?: string;
  details?: string[];
  exitCode: number;
  showStack: boolean;
}

function errName(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
}

function errStatus(err: unknown): number | undefined {
  const s = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : undefined;
}

/** Map any thrown value to a friendly one-liner plus a hint. */
export function explainError(err: unknown): Explained {
  if (err instanceof CancelledError || errName(err) === "CancelledError") {
    return { message: "Cancelled.", exitCode: 130, showStack: false };
  }
  if (err instanceof CliError) {
    return { message: err.message, hint: err.hint, details: err.details, exitCode: err.exitCode, showStack: false };
  }
  const name = errName(err);
  const message = err instanceof Error ? err.message : String(err);
  const withDetails = (e: unknown) => {
    const d = (e as { errors?: unknown }).errors;
    return Array.isArray(d) ? d.map(String) : undefined;
  };
  if (name === "MissingApiKeyError") {
    return {
      message: "No Anthropic API key found.",
      hint: `Set ${c.bold("ANTHROPIC_API_KEY")} (export it or add it to .env), or pass ${c.bold("--api-key")}.`,
      exitCode: 1,
      showStack: false,
    };
  }
  if (name === "SpecValidationError" || name === "SpecNotFoundError" || name === "SpecParseError") {
    const file = (err as { file?: unknown }).file;
    const hint = (err as { hint?: string }).hint;
    if (typeof file === "string") {
      const shown = displayPath(file);
      if (name === "SpecNotFoundError") {
        const dir = displayPath(path.dirname(file));
        return { message: `No ${path.basename(file)} in ${dir === "." ? "this directory" : dir}`, hint, exitCode: 1, showStack: false };
      }
      if (name === "SpecParseError") return { message: describeJsonError(file, shown, message), hint, exitCode: 1, showStack: false };
      return { message: message.split(file).join(shown), hint, details: withDetails(err), exitCode: 1, showStack: false };
    }
    return { message, hint, details: withDetails(err), exitCode: 1, showStack: false };
  }
  if (name === "WriterError") {
    return { message, hint: (err as { hint?: string }).hint, exitCode: 1, showStack: false };
  }
  if (name === "LLMError") {
    const kind = (err as { kind?: string }).kind;
    if (kind === "aborted") return { message: "Aborted.", exitCode: 130, showStack: false };
    const hints: Record<string, string> = {
      auth: "Fix ANTHROPIC_API_KEY (or --api-key), or use --offline.",
      network: "Check your network / HTTPS_PROXY, or use --offline.",
      timeout: "Retry, or use --offline.",
      not_found: "Try --model claude-opus-5.",
      rate_limit: "Wait a minute, or lower --concurrency.",
      overloaded: "Retry in a minute.",
    };
    return { message, hint: kind ? hints[kind] : undefined, exitCode: 1, showStack: false };
  }
  const status = errStatus(err);
  if (name === "AuthenticationError" || status === 401) {
    return {
      message: "Anthropic rejected the API key (401 Unauthorized).",
      hint: "Check ANTHROPIC_API_KEY — it may be revoked, mistyped, or for another workspace.",
      exitCode: 1,
      showStack: false,
    };
  }
  if (name === "PermissionDeniedError" || status === 403) {
    return { message: `Anthropic API permission denied: ${message}`, hint: "Your key may not have access to this model. Try --model.", exitCode: 1, showStack: false };
  }
  if (name === "NotFoundError" && status === 404) {
    return { message: `Anthropic API: ${message}`, hint: "The model id may be wrong. Try --model claude-opus-5.", exitCode: 1, showStack: false };
  }
  if (name === "RateLimitError" || status === 429) {
    return { message: "Rate limited by the Anthropic API.", hint: "Wait a moment and retry, or lower --concurrency.", exitCode: 1, showStack: false };
  }
  if (status === 529 || name === "OverloadedError") {
    return { message: "The Anthropic API is overloaded right now.", hint: "Retry in a minute.", exitCode: 1, showStack: false };
  }
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return { message: `Could not reach the Anthropic API: ${message}`, hint: "Check your network / proxy settings, or use --offline.", exitCode: 1, showStack: false };
  }
  if (name === "AbortError" || name === "APIUserAbortError") {
    return { message: "Aborted.", exitCode: 130, showStack: false };
  }
  if (/\bnot\s+implemented\b/i.test(message)) {
    return {
      message,
      hint: "This part of decree-harness is not available in this build yet.",
      exitCode: 1,
      showStack: false,
    };
  }
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
    return { message, exitCode: 1, showStack: false };
  }
  return { message: message || "Unknown error", exitCode: 1, showStack: true };
}

/** `decree.json:12 is not valid JSON (unexpected ",")` from V8's JSON.parse message. */
function describeJsonError(file: string, shown: string, message: string): string {
  if (/Unexpected end of JSON input/i.test(message)) return `${shown} is not valid JSON: the file ends too early (missing a closing bracket?)`;
  const m = /Unexpected token '(.+?)', (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(message);
  const m2 = /in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(message);
  let line: number | undefined;
  try {
    const text = readFileSync(file, "utf8");
    if (m2?.[2]) line = Number(m2[2]);
    else if (m2) line = text.slice(0, Number(m2[1])).split("\n").length;
    else if (m) {
      const at = text.indexOf(m[2]);
      if (at >= 0) {
        const tok = m[2].indexOf(m[1], Math.floor(m[2].length / 2) - 2);
        line = text.slice(0, at + Math.max(0, tok)).split("\n").length;
      }
    }
  } catch {
    // unreadable now; fall back to the message without a line number
  }
  const what = m ? `unexpected "${m[1]}"` : message.replace(/^.*?is not valid JSON:\s*/s, "").split("\n")[0];
  return `${shown}${line ? `:${line}` : ""} is not valid JSON (${what})`;
}

/**
 * Restyle commander's own parse errors (unknown option, missing argument…) to
 * match ours: `✗ Unknown option --targts. Did you mean --targets?`
 */
export function formatCommanderError(raw: string): string {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let msg = (lines[0] ?? "").replace(/^error:\s*/, "");
  msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  const rest = lines
    .slice(1)
    .map((l) => l.replace(/^\((.*)\)$/, "$1"))
    .join(" ");
  if (rest && !/[.?!]$/.test(msg)) msg += ".";
  return `${c.red(sym.fail)} ${c.red(msg)}${rest ? ` ${rest}` : ""}\n`;
}

/** Print an error nicely and return the process exit code. */
export function handleError(err: unknown): number {
  if (err instanceof SilentExit) return err.exitCode;
  const e = explainError(err);
  const out = (s: string) => process.stderr.write(`${s}\n`);
  if (e.exitCode === 130 && !e.hint) {
    out(c.dim(e.message));
    return e.exitCode;
  }
  const width = termWidth(process.stderr);
  out(wrapText(`${c.red(sym.fail)} ${c.red(e.message)}`, width, "  "));
  for (const d of e.details ?? []) out(wrapText(`  ${c.dim(sym.bullet)} ${d.replace(/"\|"/g, '" | "')}`, width, "    "));
  if (e.hint) out(wrapText(`  ${c.dim("hint:")} ${e.hint}`, width, "        "));
  if (uiState.verbose && err instanceof Error && err.stack) {
    out(c.dim(err.stack));
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.stack) out(c.dim(`Caused by: ${cause.stack}`));
  } else if (e.showStack) {
    out(`  ${c.dim("Run again with --verbose for the stack trace.")}`);
  }
  return e.exitCode;
}
