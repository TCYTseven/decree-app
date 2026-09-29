import type { Command } from "commander";
import { cloud } from "../cloud/api.js";
import { apiUrlFor, deleteCredentials, readCredentials } from "../cloud/credentials.js";
import { log } from "../ui/logger.js";
import { c, sym } from "../ui/theme.js";

/** Revoke the saved token on the server and forget it locally. */
export async function logoutCommand(_opts: unknown, _cmd: Command): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    log.raw("Not logged in.");
  } else {
    try {
      await cloud.logout(apiUrlFor(creds), creds.token);
    } catch (err) {
      log.warn(`Couldn't revoke the token on the server (${(err as Error).message}). Revoke it under API tokens on the dashboard.`);
    }
    await deleteCredentials();
    log.raw(`${c.green(sym.ok)} Logged out${creds.email ? ` of ${creds.email}` : ""}.`);
  }
  if (process.env.DECREE_TOKEN) log.raw(c.dim("DECREE_TOKEN is still set in this environment and will keep working."));
}
