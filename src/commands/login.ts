import os from "node:os";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { cloud, isTokenShape, newToken } from "../cloud/api.js";
import { apiUrlFor, normalizeApiUrl, readCredentials, writeCredentials } from "../cloud/credentials.js";
import { banner } from "../ui/banner.js";
import { CliError } from "../ui/errors.js";
import { displayPath } from "../ui/format.js";
import { isTTY, log } from "../ui/logger.js";
import { createSpinner } from "../ui/spinner.js";
import { c } from "../ui/theme.js";
import { openBrowser } from "./preview.js";
import { selfCommand } from "./context.js";
import { selfHostHint } from "./push.js";

export interface LoginCmdOptions {
  url?: string;
  token?: string;
  browser?: boolean;
}

/** Floor for the server's poll interval; tests lower it through DECREE_MIN_POLL_MS. */
const minPollMs = () => Number(process.env.DECREE_MIN_POLL_MS ?? 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connect the CLI to a self-hosted Decree dashboard. The CLI makes a token,
 * sends only its hash, and waits while you approve the login code in the
 * browser.
 */
export async function loginCommand(opts: LoginCmdOptions, _cmd: Command): Promise<void> {
  const existing = await readCredentials();
  // --url, else DECREE_API_URL, else the dashboard of the saved login.
  let apiUrl = apiUrlFor(existing);
  if (opts.url !== undefined) {
    apiUrl = normalizeApiUrl(opts.url);
    if (!apiUrl) throw new CliError(`"${opts.url}" isn't an http(s) URL.`, { hint: "Pass the dashboard's address, e.g. --url https://decree.example.com." });
  }
  if (!apiUrl) throw new CliError("No dashboard to log in to.", { hint: selfHostHint() });
  p.intro(banner("login"));

  if (opts.token !== undefined) {
    const token = opts.token.trim();
    if (!isTokenShape(token)) {
      throw new CliError("That doesn't look like a Decree token (dk_ followed by 48 hex characters).", {
        hint: "Create one under API tokens on the dashboard.",
      });
    }
    const me = await cloud.whoami(apiUrl, token);
    const file = await writeCredentials({ token, apiUrl, email: me.email, createdAt: new Date().toISOString() });
    p.outro(`Logged in as ${c.bold(me.email)} ${c.dim(`(saved to ${displayPath(file)})`)}`);
    return;
  }

  if (existing && apiUrlFor(existing) === apiUrl) {
    try {
      const me = await cloud.whoami(apiUrl, existing.token);
      p.outro(`Already logged in as ${c.bold(me.email)}. Run \`${selfCommand()} logout\` to switch accounts.`);
      return;
    } catch (err) {
      if ((err as { status?: number }).status !== 401) throw err;
      log.warn("The saved login was revoked; starting a new one.");
    }
  }

  const token = newToken();
  const start = await cloud.startLogin(apiUrl, token, os.hostname());
  log.message(
    [
      `Confirm this code in your browser: ${c.bold(c.cyan(start.userCode))}`,
      `${c.dim("If it doesn't open, visit")} ${c.underline(start.verificationUrl)}`,
    ].join("\n"),
  );
  if (opts.browser !== false && isTTY()) openBrowser(start.verificationUrl);

  const spin = createSpinner();
  spin.start("Waiting for you to approve the login…");
  const deadline = new Date(start.expiresAt).getTime();
  const intervalMs = Math.max(minPollMs(), (start.interval || 2) * 1000);
  for (;;) {
    await sleep(intervalMs);
    const poll = await cloud.pollLogin(apiUrl, token).catch((err) => {
      spin.error("Login failed");
      throw err;
    });
    if (poll.status === "approved") {
      const file = await writeCredentials({ token, apiUrl, email: poll.email, createdAt: new Date().toISOString() });
      spin.stop("Approved");
      p.outro(
        `Logged in as ${c.bold(poll.email ?? "your account")} ${c.dim(`(saved to ${displayPath(file)})`)}\n` +
          `   Next: ${c.cyan(`${selfCommand()} push`)} to sync decree.json.`,
      );
      return;
    }
    if (poll.status === "denied") {
      spin.error("Denied");
      throw new CliError("The login was denied in the browser.");
    }
    if (poll.status === "expired" || Date.now() > deadline + intervalMs) {
      spin.error("Expired");
      throw new CliError("The login code expired before it was approved.", { hint: `Run \`${selfCommand()} login\` again.` });
    }
  }
}
