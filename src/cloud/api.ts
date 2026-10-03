import { createHash, randomBytes } from "node:crypto";
import { CliError } from "../ui/errors.js";
import { DECREE_VERSION } from "../version.js";

/** A failed call to the Decree API, with a hint for the terminal. */
export class CloudError extends CliError {
  status?: number;
  constructor(message: string, opts: { hint?: string; status?: number } = {}) {
    super(message, { hint: opts.hint });
    this.name = "CloudError";
    this.status = opts.status;
  }
}

/** Server hints predate self-hosting and say `decree login`, which now needs --url; 401s get this one instead. */
const LOGIN_HINT = "Run `npx decree-harness login --url <your dashboard>` again (in CI, check DECREE_TOKEN and DECREE_API_URL).";

/** A new API token: `dk_` + 48 hex chars. Only its sha256 is ever sent until approved. */
export function newToken(): string {
  return `dk_${randomBytes(24).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isTokenShape(token: string): boolean {
  return /^dk_[0-9a-f]{48}$/.test(token);
}

interface RequestOpts {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** JSON request to the Decree API; throws CloudError with a useful hint on failure. */
export async function cloudRequest<T>(apiUrl: string, route: string, opts: RequestOpts = {}): Promise<T> {
  const url = `${apiUrl.replace(/\/+$/, "")}${route}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `decree-harness/${DECREE_VERSION}`,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new CloudError(`${hostOf(apiUrl)} did not answer in time.`, { hint: "Retry in a moment." });
    }
    const code = e.cause?.code ? ` (${e.cause.code})` : "";
    throw new CloudError(`Could not reach ${hostOf(apiUrl)}${code}.`, {
      hint: "Check your network or HTTPS_PROXY. DECREE_API_URL overrides the server.",
    });
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const body = (json && typeof json === "object" ? json : {}) as { error?: unknown; hint?: unknown };
    const message = typeof body.error === "string" ? body.error : `${hostOf(apiUrl)} answered HTTP ${res.status}.`;
    const hint = res.status === 401 ? LOGIN_HINT : typeof body.hint === "string" ? body.hint : undefined;
    throw new CloudError(message, { hint, status: res.status });
  }
  if (json === undefined) {
    throw new CloudError(`${hostOf(apiUrl)} sent a response that isn't JSON.`, {
      hint: "Is DECREE_API_URL pointing at the Decree dashboard?",
    });
  }
  return json as T;
}

function hostOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}

export interface LoginStart {
  userCode: string;
  expiresAt: string;
  verificationUrl: string;
  /** Seconds between polls. */
  interval: number;
}

export interface LoginPoll {
  status: "pending" | "approved" | "denied" | "expired";
  email?: string;
}

export interface WhoAmI {
  email: string;
  tokenName: string;
  tokenPrefix: string;
  harnesses: number;
}

export interface PushResult {
  slug: string;
  version: number;
  created: boolean;
  url: string;
  evalRunId?: string;
}

export const cloud = {
  startLogin: (apiUrl: string, token: string, clientName: string) =>
    cloudRequest<LoginStart>(apiUrl, "/api/v1/cli/login", {
      body: { tokenHash: hashToken(token), tokenPrefix: token.slice(0, 7), clientName },
    }),
  pollLogin: (apiUrl: string, token: string) => cloudRequest<LoginPoll>(apiUrl, "/api/v1/cli/login/poll", { method: "POST", token, body: {} }),
  whoami: (apiUrl: string, token: string) => cloudRequest<WhoAmI>(apiUrl, "/api/v1/whoami", { token }),
  logout: (apiUrl: string, token: string) => cloudRequest<{ ok: boolean }>(apiUrl, "/api/v1/logout", { method: "POST", token, body: {} }),
  pushHarness: (apiUrl: string, token: string, payload: unknown) =>
    cloudRequest<PushResult>(apiUrl, "/api/v1/harnesses", { token, body: payload, timeoutMs: 60_000 }),
  pushEvals: (apiUrl: string, token: string, payload: unknown) =>
    cloudRequest<PushResult>(apiUrl, "/api/v1/evals", { token, body: payload, timeoutMs: 60_000 }),
};
