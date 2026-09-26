import type { ToolSpec } from "../../core/types.js";
import { anySignal, envOf, fail, redactFor, stringifyValue, truncateHead, type ToolContext, type ToolInput, type ToolOutput } from "./common.js";

export const HTTP_TIMEOUT_MS = 60_000;
export const HTTP_MAX_BODY_CHARS = 50_000;
/** Same-origin redirects followed per request; cross-origin redirects are never followed. */
export const HTTP_MAX_REDIRECTS = 5;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Build the HTTP request for an http tool call per ARCHITECTURE "Tool semantics". */
export function prepareHttpRequest(tool: ToolSpec, input: ToolInput, ctx: ToolContext): PreparedRequest {
  const http = tool.http;
  if (!http) throw new Error(`tool ${tool.name} has kind "http" but no http binding`);
  const env = envOf(ctx);
  const base = env[http.baseUrlEnv] || http.defaultBaseUrl;
  if (!base) throw new Error(`Base URL not configured: set ${http.baseUrlEnv}`);

  const consumed = new Set<string>();
  let missing: string | undefined;
  let dotSegment: string | undefined;
  // Own properties only: a param named "constructor" must not read Object.prototype.
  const get = (name: string): unknown => (Object.hasOwn(input, name) ? input[name] : undefined);
  const pathPart = http.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    consumed.add(name);
    const v = get(name);
    if (v === undefined || v === null) {
      missing ??= name;
      return "";
    }
    const text = stringifyValue(v);
    // "." and ".." survive encodeURIComponent and the URL parser would resolve them as
    // dot segments, letting a model-supplied id walk up the API path (/users/.. -> /).
    if (text === "." || text === "..") dotSegment ??= name;
    return encodeURIComponent(text);
  });
  if (missing) throw new Error(`missing path parameter "${missing}"`);
  if (dotSegment) throw new Error(`path parameter "${dotSegment}" may not be "." or ".."`);

  const url = new URL(base.replace(/\/+$/, "") + pathPart);
  for (const key of http.queryParams ?? []) {
    consumed.add(key);
    const v = get(key);
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(key, stringifyValue(item));
    else url.searchParams.append(key, stringifyValue(v));
  }

  const headers: Record<string, string> = {};
  for (const key of http.headerParams ?? []) {
    consumed.add(key);
    const v = get(key);
    if (v === undefined || v === null) continue;
    headers[key] = stringifyValue(v);
  }

  const auth = http.auth;
  if (auth && auth.type !== "none" && auth.env) {
    const secret = env[auth.env];
    if (secret) {
      if (auth.type === "bearer") headers["Authorization"] = `Bearer ${secret}`;
      else if (auth.type === "header" && auth.header) headers[auth.header] = secret;
    }
  }

  let body: string | undefined;
  if (BODY_METHODS.has(http.method)) {
    let payload: unknown;
    if (http.bodyParam) {
      payload = get(http.bodyParam);
    } else {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) if (!consumed.has(k) && v !== undefined) rest[k] = v;
      payload = Object.keys(rest).length ? rest : undefined;
    }
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
    }
  }
  return { method: http.method, url: url.toString(), headers, body };
}

export function describeHttp(req: PreparedRequest): string {
  return `[dry run] would ${req.method} ${req.url}${req.body !== undefined ? ` with JSON body ${req.body}` : ""}`;
}

export async function executeHttp(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  let req: PreparedRequest;
  try {
    req = prepareHttpRequest(tool, input, ctx);
  } catch (err) {
    return fail(`HTTP request not sent: ${(err as Error).message}`);
  }
  if (ctx.dryRun && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return { output: describeHttp(req), isError: false };
  }
  try {
    const { res, note } = await fetchSameOrigin(req, anySignal([AbortSignal.timeout(HTTP_TIMEOUT_MS), ctx.signal]));
    const text = redactFor(ctx, await res.text());
    return {
      output: `HTTP ${res.status} ${res.statusText}\n${note ? `${note}\n` : ""}${truncateHead(text, HTTP_MAX_BODY_CHARS)}`,
      isError: res.status >= 400,
    };
  } catch (err) {
    const e = err as Error;
    // undici reports "fetch failed" and hides the useful part (ECONNREFUSED, ENOTFOUND, ...) in `cause`.
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    const reason =
      e.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : `${e.message}${detail && !e.message.includes(detail) ? ` (${detail})` : ""}`;
    const hint = cause?.code === "ECONNREFUSED" ? ". Nothing is listening there: the service is probably not running." : "";
    return fail(`HTTP request failed: ${req.method} ${req.url}: ${reason}${hint}`);
  }
}

/**
 * fetch with `redirect: "manual"`: follow at most HTTP_MAX_REDIRECTS redirects that stay
 * on the same origin (scheme + host + port). A redirect to another origin is returned
 * as-is with a note, so auth headers (bearer or custom header) never leave the API's origin.
 * 303, and 301/302 after POST, continue as GET without a body (like browsers).
 */
export async function fetchSameOrigin(req: PreparedRequest, signal: AbortSignal): Promise<{ res: Response; note?: string }> {
  let url = req.url;
  let method = req.method;
  let body = req.body;
  const headers = { ...req.headers };
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { method, headers, body, signal, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return { res };
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { res, note: `[redirect not followed: invalid Location ${JSON.stringify(location)}]` };
    }
    if (next.origin !== new URL(url).origin) {
      return { res, note: `[redirect to ${next.toString()} not followed: different origin]` };
    }
    if (hop >= HTTP_MAX_REDIRECTS) return { res, note: `[redirect not followed: more than ${HTTP_MAX_REDIRECTS} redirects]` };
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = undefined;
      for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") delete headers[k];
    }
    url = next.toString();
  }
}
