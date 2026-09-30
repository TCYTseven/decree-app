import type { Command } from "commander";
import { cloud, type PushResult } from "../cloud/api.js";
import { resolveAuth, type ResolvedAuth } from "../cloud/credentials.js";
import { gitInfo } from "../cloud/git.js";
import { buildSyncPayload } from "../cloud/payload.js";
import { loadSpec } from "../core/config.js";
import { CliError } from "../ui/errors.js";
import { groupWarnings, plural } from "../ui/format.js";
import { log, setQuiet } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";
import { rootFor, selfCommand } from "./context.js";

export interface PushCmdOptions {
  message?: string;
  name?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** How to point the CLI at a dashboard, since trydecree.com doesn't host one yet. */
export function selfHostHint(): string {
  return `trydecree.com doesn't host dashboards yet. Self-host the Decree dashboard, then run \`${selfCommand()} login --url https://your-dashboard\` (or set DECREE_API_URL).`;
}

/** Auth for commands that upload, or a friendly error. */
export async function requireAuth(): Promise<ResolvedAuth & { apiUrl: string }> {
  const auth = await resolveAuth();
  if (!auth) {
    throw new CliError("Not logged in to a Decree dashboard.", {
      hint: `Run \`${selfCommand()} login --url https://your-dashboard\`, or set DECREE_TOKEN and DECREE_API_URL in CI.`,
    });
  }
  if (!auth.apiUrl) {
    throw new CliError("DECREE_TOKEN is set but DECREE_API_URL isn't.", {
      hint: "Set DECREE_API_URL to your self-hosted dashboard, e.g. https://decree.example.com.",
    });
  }
  return { ...auth, apiUrl: auth.apiUrl };
}

/** One line describing a push result, e.g. `✓ Pushed acme-orders v3 · https://…`. */
export function pushedLine(r: PushResult): string {
  const what = r.created ? `Pushed ${c.bold(r.slug)} ${c.cyan(`v${r.version}`)}` : `${c.bold(r.slug)} is up to date ${c.dim(`(v${r.version})`)}`;
  return `${c.green(sym.ok)} ${what} ${c.dim(sym.dot)} ${c.underline(r.url)}`;
}

/** Sync decree.json to the dashboard; a changed spec becomes a new version. */
export async function pushCommand(opts: PushCmdOptions, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  if (opts.json) setQuiet(true);
  const { spec, warnings } = await loadSpec(root);
  for (const w of groupWarnings(warnings)) log.warn(w);
  const git = await gitInfo(root);
  const payload = buildSyncPayload(spec, { git, message: opts.message, slug: opts.name });

  if (opts.dryRun) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    const where = git.branch ? `${git.branch}${git.commit ? `@${git.commit.slice(0, 7)}` : ""}${git.dirty ? " (dirty)" : ""}` : "no git info";
    log.raw(
      `Would push ${c.bold(payload.slug ?? spec.name)} ${c.dim(
        `${sym.dot} ${plural(spec.tools.length, "tool")} ${sym.dot} ${plural(spec.subagents.length, "subagent")} ${sym.dot} ${plural(spec.evals.length, "eval")} ${sym.dot} ${where}`,
      )}`,
    );
    return;
  }

  const auth = await requireAuth();
  const result = await cloud.pushHarness(auth.apiUrl, auth.token, payload);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  log.raw(pushedLine(result));
}
