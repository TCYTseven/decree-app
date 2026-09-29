import type { Command } from "commander";
import { cloud } from "../cloud/api.js";
import { resolveAuth } from "../cloud/credentials.js";
import { CliError } from "../ui/errors.js";
import { plural } from "../ui/format.js";
import { log } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";
import { selfCommand } from "./context.js";

/** Which dashboard account this machine pushes to. */
export async function whoamiCommand(opts: { json?: boolean }, _cmd: Command): Promise<void> {
  const auth = await resolveAuth();
  if (!auth) {
    throw new CliError("Not logged in.", { hint: `Run \`${selfCommand()} login\`, or set DECREE_TOKEN in CI.` });
  }
  const me = await cloud.whoami(auth.apiUrl, auth.token);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...me, apiUrl: auth.apiUrl, source: auth.source }, null, 2)}\n`);
    return;
  }
  log.raw(`${c.green(sym.ok)} ${c.bold(me.email)}`);
  log.raw(
    c.dim(
      `  ${me.tokenName} (${me.tokenPrefix}…${auth.source === "env" ? ", from DECREE_TOKEN" : ""}) ${sym.dot} ${plural(me.harnesses, "harness", "harnesses")} ${sym.dot} ${auth.apiUrl}`,
    ),
  );
}
