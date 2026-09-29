/**
 * A fake trydecree.com API for the login/push/eval --push tests. It keeps the
 * same contract as the dashboard's /api/v1 routes: tokens are stored by
 * sha256, logins are approved (or denied) by `decide`, pushes dedupe on an
 * unchanged spec.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDecree {
  url: string;
  requests: { method: string; path: string; auth?: string; body: unknown }[];
  /** Token hashes the "dashboard" accepted. */
  tokens: Map<string, { email: string; revoked: boolean }>;
  /** What the next login poll answers once it stops being pending. */
  decide: "approved" | "denied" | "expired";
  /** Polls answered "pending" before deciding. */
  pendingPolls: number;
  harnesses: Map<string, { version: number; spec: string }>;
  close(): Promise<void>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startFakeDecree(email = "dev@example.com"): Promise<FakeDecree> {
  const logins = new Map<string, { prefix: string; code: string; polls: number }>();
  const state: Omit<FakeDecree, "url" | "close"> = {
    requests: [],
    tokens: new Map(),
    decide: "approved",
    pendingPolls: 1,
    harnesses: new Map(),
  };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    state.requests.push({ method: req.method ?? "", path: req.url ?? "", auth, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const account = () => {
      const t = auth ? state.tokens.get(sha(auth)) : undefined;
      return t && !t.revoked ? t : undefined;
    };

    switch (`${req.method} ${req.url}`) {
      case "POST /api/v1/cli/login": {
        logins.set(body.tokenHash, { prefix: body.tokenPrefix, code: "ABCD-2345", polls: 0 });
        return send(200, {
          userCode: "ABCD-2345",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          verificationUrl: `${fake.url}/dashboard/cli?code=ABCD-2345`,
          interval: 0.01,
        });
      }
      case "POST /api/v1/cli/login/poll": {
        const login = auth ? logins.get(sha(auth)) : undefined;
        if (!login) return send(404, { error: "Unknown login request." });
        if (login.polls++ < state.pendingPolls) return send(200, { status: "pending" });
        if (state.decide === "approved") state.tokens.set(sha(auth!), { email, revoked: false });
        return send(200, { status: state.decide, email: state.decide === "approved" ? email : undefined });
      }
      case "GET /api/v1/whoami": {
        const a = account();
        if (!a) return send(401, { error: "This token is invalid or was revoked." });
        return send(200, { email: a.email, tokenName: "CLI on test", tokenPrefix: auth!.slice(0, 7), harnesses: state.harnesses.size });
      }
      case "POST /api/v1/logout": {
        const t = auth ? state.tokens.get(sha(auth)) : undefined;
        if (t) t.revoked = true;
        return send(200, { ok: true });
      }
      case "POST /api/v1/harnesses":
      case "POST /api/v1/evals": {
        if (!account()) return send(401, { error: "This token is invalid or was revoked.", hint: "Run `decree login` again." });
        const slug = body.slug ?? body.spec?.name;
        const spec = JSON.stringify(body.spec);
        const prev = state.harnesses.get(slug);
        const created = !prev || prev.spec !== spec;
        const version = created ? (prev?.version ?? 0) + 1 : prev.version;
        state.harnesses.set(slug, { version, spec });
        return send(200, {
          slug,
          version,
          created,
          url: `${fake.url}/dashboard/harnesses/${slug}`,
          ...(req.url === "/api/v1/evals" ? { evalRunId: "run-1" } : {}),
        });
      }
      default:
        return send(404, { error: "not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeDecree = Object.assign(state, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  return fake;
}

/** Register a token as if it had been approved in the dashboard. */
export function seedToken(fake: FakeDecree, token: string, email = "dev@example.com"): void {
  fake.tokens.set(sha(token), { email, revoked: false });
}
