import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type { IncomingMessage } from "node:http";

/**
 * Security model for the preview server.
 *
 * 1. Bind to 127.0.0.1 by default, so nothing off the machine can connect.
 * 2. Host allow-list on EVERY request (the page included). A DNS-rebinding attack points an attacker's
 *    domain at 127.0.0.1; the browser then sends `Host: evil.example:4321`, which we refuse, so the
 *    attacker's page can never read the HTML (and the token embedded in it).
 * 3. Every /api request needs the per-session token in the `x-decree-token` header. Other sites cannot
 *    read our page (same-origin policy), so they cannot learn the token, and a custom header cannot be
 *    sent cross-origin without a CORS preflight, which we never approve.
 * 4. When a browser sends `Origin` (every fetch/POST does), it must be one of our own origins. That
 *    blocks CSRF even if a token somehow leaked into another origin.
 * 5. `Sec-Fetch-Site: cross-site` requests to the API are refused as a belt-and-braces check.
 */

export const TOKEN_HEADER = "x-decree-token";

export function createToken(): string {
  return randomBytes(24).toString("base64url");
}

export function tokensEqual(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** Host names (without port) the server answers to. */
export function allowedHostnames(bindHost: string): Set<string> {
  const names = new Set<string>(LOOPBACK_NAMES);
  const bare = bindHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (isWildcardHost(bindHost)) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) names.add(a.family === "IPv6" ? `[${a.address.toLowerCase()}]` : a.address);
    }
    names.add(os.hostname().toLowerCase());
  } else if (bare) {
    names.add(bare.includes(":") ? `[${bare}]` : bare);
  }
  return names;
}

export class RequestGuard {
  private readonly hosts: Set<string>;
  constructor(
    public readonly token: string,
    bindHost: string,
    private port: number,
  ) {
    this.hosts = allowedHostnames(bindHost);
  }

  setPort(port: number): void {
    this.port = port;
  }

  /** `Host` header must name one of our hostnames and our port. */
  hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim().toLowerCase());
    if (!m) return false;
    const port = m[2] ? Number(m[2]) : 80;
    return port === this.port && this.hosts.has(m[1]);
  }

  /** `Origin`, when present, must be http://<allowed host>:<port>. */
  originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true; // non-browser clients (curl, tests) and same-origin GETs
    if (origin === "null") return false;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (u.protocol !== "http:") return false;
    return this.hostAllowed(u.host);
  }

  /** Returns a reason string when the request must be refused, else undefined. */
  check(req: IncomingMessage, opts: { api: boolean }): { status: number; reason: string } | undefined {
    if (!this.hostAllowed(req.headers.host)) return { status: 421, reason: "Unexpected Host header (possible DNS rebinding); open the URL decree printed." };
    const origin = req.headers.origin;
    if (!this.originAllowed(typeof origin === "string" ? origin : undefined)) return { status: 403, reason: "Cross-origin request refused." };
    if (!opts.api) return undefined;
    if (req.headers["sec-fetch-site"] === "cross-site") return { status: 403, reason: "Cross-site request refused." };
    if (!tokensEqual(this.token, req.headers[TOKEN_HEADER])) return { status: 401, reason: "Missing or invalid session token. Reload the page." };
    return undefined;
  }
}
