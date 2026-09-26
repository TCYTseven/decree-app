import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { unsafeTemplateError } from "../../core/shell-template.js";
import type { JSONSchema, ToolSpec } from "../../core/types.js";
import {
  confinePath,
  fail,
  redactFor,
  stringifyValue,
  truncateTail,
  type ToolContext,
  type ToolInput,
  type ToolOutput,
} from "./common.js";

export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const SHELL_MAX_OUTPUT_CHARS = 30_000;

/** POSIX single-quote escaping: the result is always one literal shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ShellTemplateError extends Error {}

/** Own-property lookup: a placeholder named `constructor` or `__proto__` must not reach Object.prototype. */
function own(input: ToolInput, name: string): unknown {
  return Object.hasOwn(input, name) ? input[name] : undefined;
}

/** Whether the input schema lets `name` take values starting with "-" (`"x-allow-flags": true`). */
export function allowsFlags(schema: JSONSchema | undefined, name: string): boolean {
  const props = schema?.properties;
  const prop = props && Object.hasOwn(props, name) ? props[name] : undefined;
  return !!prop && typeof prop === "object" && prop["x-allow-flags"] === true;
}

/**
 * Render a shell template: `{{param}}` -> quoted input value. Missing/undefined
 * params become empty strings and repeated spaces in the template are collapsed
 * (values themselves are never altered).
 *
 * Throws ShellTemplateError when a placeholder is not a bare shell word (inside
 * quotes, backticks, `${...}`, a comment, or right after `$`, `\` or `$(`), and when
 * a value starts with "-" (option injection) unless its schema property sets
 * `"x-allow-flags": true`.
 */
export function renderShellCommand(template: string, input: ToolInput, schema?: JSONSchema): string {
  const unsafe = unsafeTemplateError(template);
  if (unsafe) throw new ShellTemplateError(unsafe);
  const placeholder = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
  const missing = (name: string) => own(input, name) === undefined || own(input, name) === null;
  for (const m of template.matchAll(placeholder)) {
    const name = m[1]!;
    if (missing(name)) continue;
    if (stringifyValue(own(input, name)).startsWith("-") && !allowsFlags(schema, name)) {
      throw new ShellTemplateError(`parameter values may not start with '-' ("${name}"); set "x-allow-flags": true on the parameter to allow flags`);
    }
  }
  const withoutMissing = template.replace(placeholder, (m, name: string) => (missing(name) ? "" : m));
  const collapsed = withoutMissing.replace(/ {2,}/g, " ").trim();
  return collapsed.replace(placeholder, (_m, name: string) => shellQuote(stringifyValue(own(input, name))));
}

export function findBlocked(command: string, blocked: string[]): string | undefined {
  return blocked.find((b) => b && command.includes(b));
}

export async function executeShell(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  const binding = tool.shell;
  if (!binding) return fail(`tool ${tool.name} has kind "shell" but no shell binding`);
  let command: string;
  try {
    command = renderShellCommand(binding.command, input, tool.inputSchema);
  } catch (err) {
    if (err instanceof ShellTemplateError) return fail(`Refused: ${err.message}`);
    throw err;
  }
  const blocked = findBlocked(command, ctx.spec.guardrails.blockedCommands ?? []);
  if (blocked) return fail(`Refused: command contains blocked pattern "${blocked}" (guardrails.blockedCommands).`);

  let cwd: string;
  try {
    cwd = confinePath(ctx.projectRoot, binding.cwd ?? ".");
  } catch (err) {
    return fail(`Refused: ${(err as Error).message}`);
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(`Working directory does not exist: ${binding.cwd ?? "."}`);

  const rel = path.relative(ctx.projectRoot, cwd) || ".";
  if (ctx.dryRun) return { output: `[dry run] would run \`${command}\` in ${rel}`, isError: false };

  const timeoutMs = binding.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS;
  return runShell(command, cwd, timeoutMs, ctx.signal, (text) => redactFor(ctx, text));
}

/**
 * Run `/bin/sh -c command` in its own process group; kill the whole group on timeout/abort.
 * `scrub` (secret redaction) runs before any truncation so a cut never leaves part of a secret.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  scrub: (text: string) => string = (t) => t,
): Promise<ToolOutput> {
  return new Promise((resolve) => {
    let out = "";
    let dropped = 0;
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      // Keep memory bounded: retain roughly 2x the final cap while streaming.
      if (out.length > SHELL_MAX_OUTPUT_CHARS * 2) {
        out = scrub(out);
        const cut = Math.max(0, out.length - SHELL_MAX_OUTPUT_CHARS);
        dropped += cut;
        out = out.slice(cut);
      }
    };

    let child;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: process.env,
        detached: true, // new process group so we can kill descendants too
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve(fail(`Failed to start command: ${(err as Error).message}`));
      return;
    }

    let timedOut = false;
    let aborted = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(fail(`Failed to start command: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const body = truncateTail(scrub(out), SHELL_MAX_OUTPUT_CHARS, dropped);
      if (timedOut) {
        resolve(fail(`exit code: timeout\n${body}\n[killed after ${timeoutMs}ms timeout]`));
      } else if (aborted) {
        resolve(fail(`exit code: aborted\n${body}\n[killed: run aborted]`));
      } else {
        const exit = code ?? (sig ? `signal ${sig}` : "unknown");
        resolve({ output: `exit code: ${exit}\n${body}`, isError: code !== 0 });
      }
    });
  });
}
