import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolSpec } from "../../core/types.js";
import { confinePath, fail, stringifyValue, truncateTail, type ToolContext, type ToolInput, type ToolOutput } from "./common.js";

export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const SHELL_MAX_OUTPUT_CHARS = 30_000;

/** POSIX single-quote escaping: the result is always one literal shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a shell template: `{{param}}` -> quoted input value. Missing/undefined
 * params become empty strings and repeated spaces in the template are collapsed
 * (values themselves are never altered).
 */
export function renderShellCommand(template: string, input: ToolInput): string {
  const placeholder = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
  const withoutMissing = template.replace(placeholder, (m, name: string) =>
    input[name] === undefined || input[name] === null ? "" : m,
  );
  const collapsed = withoutMissing.replace(/ {2,}/g, " ").trim();
  return collapsed.replace(placeholder, (_m, name: string) => shellQuote(stringifyValue(input[name])));
}

export function findBlocked(command: string, blocked: string[]): string | undefined {
  return blocked.find((b) => b && command.includes(b));
}

export async function executeShell(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  const binding = tool.shell;
  if (!binding) return fail(`tool ${tool.name} has kind "shell" but no shell binding`);
  const command = renderShellCommand(binding.command, input);
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
  return runShell(command, cwd, timeoutMs, ctx.signal);
}

/** Run `/bin/sh -c command` in its own process group; kill the whole group on timeout/abort. */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolOutput> {
  return new Promise((resolve) => {
    let out = "";
    let dropped = 0;
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      // Keep memory bounded: retain roughly 2x the final cap while streaming.
      if (out.length > SHELL_MAX_OUTPUT_CHARS * 2) {
        const cut = out.length - SHELL_MAX_OUTPUT_CHARS;
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
      const body = truncateTail(out, SHELL_MAX_OUTPUT_CHARS, dropped);
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
