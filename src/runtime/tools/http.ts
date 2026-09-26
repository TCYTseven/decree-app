import type { ToolSpec } from "../../core/types.js";
import { anySignal, envOf, fail, stringifyValue, truncateHead, type ToolContext, type ToolInput, type ToolOutput } from "./common.js";

export const HTTP_TIMEOUT_MS = 60_000;
export const HTTP_MAX_BODY_CHARS = 50_000;
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
  const pathPart = http.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    consumed.add(name);
    const v = input[name];
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
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(key, stringifyValue(item));
    else url.searchParams.append(key, stringifyValue(v));
  }

  const headers: Record<string, string> = {};
  for (const key of http.headerParams ?? []) {
    consumed.add(key);
    const v = input[key];
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
      payload = input[http.bodyParam];
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
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: anySignal([AbortSignal.timeout(HTTP_TIMEOUT_MS), ctx.signal]),
    });
    const text = await res.text();
    return {
      output: `HTTP ${res.status} ${res.statusText}\n${truncateHead(text, HTTP_MAX_BODY_CHARS)}`,
      isError: res.status >= 400,
    };
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : e.message;
    return fail(`HTTP request failed: ${reason}`);
  }
}
