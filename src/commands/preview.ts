import { spawn } from "node:child_process";
import type { Command } from "commander";
import { specExists } from "../core/config.js";
import { runEvals } from "../eval/index.js";
import { createLLM, resolveApiKey } from "../llm/client.js";
import { runAgent } from "../runtime/index.js";
import { startPreviewServer, type PreviewDeps } from "../preview/server.js";
import { isLoopbackHost, isWildcardHost } from "../preview/security.js";
import { banner } from "../ui/banner.js";
import { CliError, explainError } from "../ui/errors.js";
import { c, sym } from "../ui/theme.js";
import { SPEC_FILENAME } from "../version.js";
import { rootFor } from "./context.js";

export interface PreviewCmdOptions {
  port?: string;
  host?: string;
  open?: boolean;
  apiKey?: string;
}

export const DEFAULT_PREVIEW_PORT = 4321;

/** Best-effort: open `url` in the default browser. Never throws. */
export function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no browser available: the URL is printed anyway */
  }
}

/** Dependencies for the real CLI: live runtime, key lookup from flag > env > .env (project, then cwd). */
export function cliPreviewDeps(explicitKey?: string): PreviewDeps {
  return {
    resolveKey: (root) => {
      if (explicitKey?.trim()) return { key: explicitKey.trim(), source: "--api-key" };
      if (process.env.ANTHROPIC_API_KEY?.trim()) return { key: process.env.ANTHROPIC_API_KEY.trim(), source: "env" };
      const fromRoot = resolveApiKey(undefined, root);
      if (fromRoot) return { key: fromRoot, source: ".env" };
      const fromCwd = resolveApiKey(undefined, process.cwd());
      if (fromCwd) return { key: fromCwd, source: ".env" };
      return {};
    },
    runAgent,
    runEvals: (spec, opts) => runEvals(spec, opts),
    createJudge: (apiKey) => createLLM({ apiKey }),
    explainError: (err) => {
      const e = explainError(err);
      return { message: e.message, hint: e.hint };
    },
  };
}

export async function previewCommand(opts: PreviewCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  const host = (opts.host ?? "127.0.0.1").trim();
  const port = opts.port === undefined ? DEFAULT_PREVIEW_PORT : Number.parseInt(opts.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`--port must be a number between 0 and 65535 (got "${opts.port}")`);
  }
  const hasSpec = await specExists(root);

  let server;
  try {
    server = await startPreviewServer({ root, host, port, deps: cliPreviewDeps(opts.apiKey) });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND") throw new CliError(`Cannot listen on ${host}`, { hint: "Use --host 127.0.0.1 (the default)." });
    if (code === "EACCES") throw new CliError(`No permission to listen on port ${port}`, { hint: "Pick a port above 1024, e.g. --port 4321." });
    throw err;
  }

  const out = (s = "") => process.stdout.write(`${s}\n`);
  out();
  out(`${banner("preview")}`);
  out();
  out(`  ${c.green(sym.ok)} ${c.bold("Preview ready")}  ${c.cyan(c.underline(server.url))}`);
  if (server.portFallback) out(`  ${c.dim(`Port ${port} was busy, so a free port was picked.`)}`);
  out(`  ${c.dim(`Serving ${root}`)}`);
  if (!hasSpec) out(`  ${c.yellow(`${sym.warn} No ${SPEC_FILENAME} yet. Run \`decree-harness init\`; the page updates when it appears.`)}`);
  if (!isLoopbackHost(host)) {
    out(
      `  ${c.yellow(`${sym.warn} Listening on ${isWildcardHost(host) ? "all interfaces" : host}. Anyone who can reach this address and load the page can drive your agent.`)}`,
    );
  }
  const key = cliPreviewDeps(opts.apiKey).resolveKey(root);
  if (!key.key) out(`  ${c.dim(`No ANTHROPIC_API_KEY: the playground and evals stay off; everything else works.`)}`);
  out(`  ${c.dim("Watching decree.json for changes · Ctrl+C to stop")}`);
  out();

  if (opts.open !== false) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  out();
  out(c.dim("Stopping preview…"));
  await server.close();
}
