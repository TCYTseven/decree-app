/**
 * `decree-harness preview` server: security (token, Host, Origin), spec read/write, generated files,
 * SSE framing, live reload, the page itself and the markdown renderer.
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringifySpec } from "../src/core/spec.js";
import { renderMarkdown } from "../src/preview/markdown.js";
import { clientScript, renderPage, scriptJson } from "../src/preview/page.js";
import { RequestGuard, TOKEN_HEADER } from "../src/preview/security.js";
import { patchSpecFile, startPreviewServer, type PreviewDeps, type PreviewServer } from "../src/preview/server.js";
import { formatSSE, parseSSE } from "../src/preview/sse.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TOKEN = "test-token-abcdefghijklmnop";
const noKeyDeps: PreviewDeps = {
  resolveKey: () => ({}),
  runAgent: async () => {
    throw new Error("runAgent should not be called");
  },
  runEvals: async () => {
    throw new Error("runEvals should not be called");
  },
};

let root: string;
let srv: PreviewServer;

async function start(deps: PreviewDeps = noKeyDeps, extra: Partial<Parameters<typeof startPreviewServer>[0]> = {}) {
  srv = await startPreviewServer({ root, port: 0, token: TOKEN, deps, watchDebounceMs: 30, ...extra });
  return srv;
}

/** Raw request so tests can set Host/Origin freely. */
function req(
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${srv.port}`, ...opts.headers };
    if (opts.token !== null) headers[TOKEN_HEADER] = opts.token ?? TOKEN;
    let data: string | undefined;
    if (opts.body !== undefined) {
      data = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      headers["content-type"] ??= "application/json";
    }
    const r = http.request({ host: "127.0.0.1", port: srv.port, method, path: p, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-preview-"));
  await fs.writeFile(path.join(root, "decree.json"), stringifySpec(sampleSpec()));
});
afterEach(async () => {
  await srv?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("security", () => {
  it("serves the page on a loopback Host and embeds the session token", async () => {
    await start();
    const r = await req("GET", "/", { token: null });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.text).toContain(`<meta name="decree-token" content="${TOKEN}">`);
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(r.text).toContain(`<script nonce="${nonce}">`);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    for (const host of [`localhost:${srv.port}`, `[::1]:${srv.port}`]) {
      expect((await req("GET", "/", { token: null, headers: { host } })).status).toBe(200);
    }
  });

  it("refuses foreign Host headers everywhere (DNS rebinding), including the page", async () => {
    await start();
    for (const host of [`evil.example:${srv.port}`, "127.0.0.1:1", "127.0.0.1", `attacker.localhost.evil:${srv.port}`]) {
      const page = await req("GET", "/", { headers: { host }, token: null });
      expect(page.status).toBe(421);
      expect(page.text).not.toContain(TOKEN);
      expect((await req("GET", "/api/state", { headers: { host } })).status).toBe(421);
    }
  });

  it("requires the token on every API route", async () => {
    await start();
    for (const [m, p] of [
      ["GET", "/api/state"],
      ["GET", "/api/files"],
      ["GET", "/api/events"],
      ["PATCH", "/api/spec"],
      ["POST", "/api/generate"],
      ["POST", "/api/chat"],
      ["POST", "/api/approval"],
      ["POST", "/api/evals"],
    ] as const) {
      const missing = await req(m, p, { token: null, body: m === "GET" ? undefined : {} });
      expect(missing.status, `${m} ${p}`).toBe(401);
      const wrong = await req(m, p, { token: TOKEN.slice(0, -1) + "X", body: m === "GET" ? undefined : {} });
      expect(wrong.status, `${m} ${p}`).toBe(401);
    }
    expect((await req("GET", "/api/state")).status).toBe(200);
  });

  it("blocks cross-origin requests even with a valid token (CSRF)", async () => {
    await start();
    const patch = { patch: { systemPrompt: "pwned" } };
    for (const origin of ["http://evil.example", "null", `https://127.0.0.1:${srv.port}`, `http://127.0.0.1:${srv.port + 1}`]) {
      const r = await req("PATCH", "/api/spec", { body: patch, headers: { origin } });
      expect(r.status, origin).toBe(403);
    }
    expect((await req("PATCH", "/api/spec", { body: patch, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(await fs.readFile(path.join(root, "decree.json"), "utf8")).not.toContain("pwned");
    // Same-origin is fine.
    const ok = await req("PATCH", "/api/spec", { body: { patch: { systemPrompt: "# Role\nHello" } }, headers: { origin: `http://localhost:${srv.port}` } });
    expect(ok.status).toBe(200);
  });

  it("requires application/json bodies (no simple-request CSRF via forms)", async () => {
    await start();
    const r = await req("PATCH", "/api/spec", { body: "patch=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(415);
  });

  it("RequestGuard host/origin parsing", () => {
    const g = new RequestGuard("t", "127.0.0.1", 4321);
    expect(g.hostAllowed("127.0.0.1:4321")).toBe(true);
    expect(g.hostAllowed("LOCALHOST:4321")).toBe(true);
    expect(g.hostAllowed("[::1]:4321")).toBe(true);
    expect(g.hostAllowed("127.0.0.1:4322")).toBe(false);
    expect(g.hostAllowed("192.168.1.5:4321")).toBe(false);
    expect(g.hostAllowed(undefined)).toBe(false);
    expect(g.originAllowed(undefined)).toBe(true);
    expect(g.originAllowed("http://localhost:4321")).toBe(true);
    expect(g.originAllowed("http://localhost:4321.evil.com")).toBe(false);
    expect(g.originAllowed("garbage")).toBe(false);
    const custom = new RequestGuard("t", "10.0.0.7", 80);
    expect(custom.hostAllowed("10.0.0.7")).toBe(true);
  });

  it("falls back to a random port when the preferred one is taken", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as { port: number }).port;
    try {
      await start(noKeyDeps, { port: busy });
      expect(srv.portFallback).toBe(true);
      expect(srv.port).not.toBe(busy);
      expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/`);
      await srv.close();
      await expect(startPreviewServer({ root, port: busy, strictPort: true, deps: noKeyDeps })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});

describe("spec read/write", () => {
  it("GET /api/state returns the validated spec, env status and key availability", async () => {
    await start();
    const s = (await req("GET", "/api/state")).json();
    expect(s.ok).toBe(true);
    expect(s.spec.name).toBe("acme-ops-agent");
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(s.apiKey).toEqual({ available: false, source: null });
    expect(typeof s.env).toBe("object");
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it("reports parse and validation errors instead of failing", async () => {
    await start();
    await fs.writeFile(path.join(root, "decree.json"), "{ nope");
    let s = (await req("GET", "/api/state")).json();
    expect(s).toMatchObject({ ok: false, kind: "parse" });
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify({ name: "x" }));
    s = (await req("GET", "/api/state")).json();
    expect(s.ok).toBe(false);
    expect(s.kind).toBe("invalid");
    expect(s.errors.join("\n")).toMatch(/systemPrompt/);
    await fs.rm(path.join(root, "decree.json"));
    s = (await req("GET", "/api/state")).json();
    expect(s.kind).toBe("missing");
  });

  it("saves the system prompt with stringifySpec formatting and a backup", async () => {
    await start();
    const before = await fs.readFile(path.join(root, "decree.json"), "utf8");
    const { hash } = (await req("GET", "/api/state")).json();
    const r = await req("PATCH", "/api/spec", { body: { patch: { systemPrompt: "# Role\nYou run Acme ops.\n" }, baseHash: hash } });
    expect(r.status).toBe(200);
    const saved = await fs.readFile(path.join(root, "decree.json"), "utf8");
    const json = JSON.parse(saved);
    expect(json.systemPrompt).toBe("# Role\nYou run Acme ops.\n");
    expect(saved).toBe(stringifySpec({ ...sampleSpec(), systemPrompt: "# Role\nYou run Acme ops.\n", $schema: json.$schema }));
    expect(Object.keys(json)[0]).toBe("$schema");
    expect(await fs.readFile(path.join(root, ".decree", "decree.backup.json"), "utf8")).toBe(before);
    expect(r.json().hash).not.toBe(hash);
  });

  it("rejects invalid saves with validateSpec errors and leaves the file alone", async () => {
    await start();
    const before = await fs.readFile(path.join(root, "decree.json"), "utf8");
    for (const bad of ["", "   \n "]) {
      const r = await req("PATCH", "/api/spec", { body: { patch: { systemPrompt: bad } } });
      expect(r.status).toBe(422);
      expect(r.json().errors.join(" ")).toMatch(/systemPrompt/);
    }
    const r2 = await req("PATCH", "/api/spec", { body: { patch: { guardrails: { approvalMode: "sometimes" } } } });
    expect(r2.status).toBe(422);
    expect(r2.json().code).toBe("invalid");
    const r3 = await req("PATCH", "/api/spec", { body: { patch: { $schema: "x", provenance: {} } } });
    expect(r3.status).toBe(400);
    expect(await fs.readFile(path.join(root, "decree.json"), "utf8")).toBe(before);
  });

  it("refuses to overwrite a newer decree.json (409 conflict)", async () => {
    await start();
    const { hash } = (await req("GET", "/api/state")).json();
    const spec = sampleSpec();
    await fs.writeFile(path.join(root, "decree.json"), stringifySpec({ ...spec, goal: "edited in vim" }));
    const r = await req("PATCH", "/api/spec", { body: { patch: { systemPrompt: "# New" }, baseHash: hash } });
    expect(r.status).toBe(409);
    expect(r.json().code).toBe("conflict");
    expect(JSON.parse(await fs.readFile(path.join(root, "decree.json"), "utf8")).goal).toBe("edited in vim");
  });

  it("patchSpecFile works without a server", async () => {
    const r = await patchSpecFile(root, { goal: "Ship it" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, "decree.json"), "utf8")).goal).toBe("Ship it");
  });
});

describe("generated files", () => {
  it("lists what generate would write, serves contents, and regenerates with the shared writer", async () => {
    await start();
    const list = (await req("GET", "/api/files")).json();
    expect(list.outDir).toBe("agent");
    expect(list.files.length).toBeGreaterThan(5);
    expect(list.files.every((f: { status: string }) => f.status === "new")).toBe(true);
    const readme = list.files.find((f: { path: string }) => f.path === "README.md");
    expect(readme).toBeTruthy();
    const file = (await req("GET", "/api/file?path=README.md")).json();
    expect(file.content).toContain("Acme Ops Agent");
    expect((await req("GET", "/api/file?path=../../etc/passwd")).status).toBe(404);

    const gen = (await req("POST", "/api/generate", { body: {} })).json();
    expect(gen.ok).toBe(true);
    expect(gen.report.created.length).toBe(list.files.length);
    expect(await fs.readFile(path.join(root, "agent", "README.md"), "utf8")).toBe(file.content);
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".decree", "manifest.json"), "utf8"));
    expect(Object.keys(manifest.outputs.agent.files)).toContain("README.md");

    // User edits are kept (same semantics as `decree-harness generate`).
    await fs.writeFile(path.join(root, "agent", "README.md"), "mine\n");
    const after = (await req("GET", "/api/files")).json();
    expect(after.files.find((f: { path: string }) => f.path === "README.md").status).toBe("edited");
    const gen2 = (await req("POST", "/api/generate", { body: {} })).json();
    expect(gen2.report.skipped).toContain("README.md");
    expect(await fs.readFile(path.join(root, "agent", "README.md"), "utf8")).toBe("mine\n");
  });

  it("returns a clear error when decree.json is invalid", async () => {
    await start();
    await fs.writeFile(path.join(root, "decree.json"), "[]");
    const r = await req("GET", "/api/files");
    expect(r.status).toBe(409);
    expect(r.json().code).toBe("spec_invalid");
  });
});

describe("SSE", () => {
  it("frames events with id, event and one data line per line", () => {
    expect(formatSSE("text", { text: "hi" }, 3)).toBe('id: 3\nevent: text\ndata: {"text":"hi"}\n\n');
    expect(formatSSE("note", "a\nb\r\nc")).toBe("event: note\ndata: a\ndata: b\ndata: c\n\n");
    expect(formatSSE("evil\nevent: x", "{}")).toBe("event: evilevent: x\ndata: {}\n\n");
    const text = formatSSE("a", { x: "line1\nline2" }, 1) + ": comment\n\n" + formatSSE("b", "p\nq");
    expect(parseSSE(text)).toEqual([
      { event: "a", data: '{"x":"line1\\nline2"}', id: "1" },
      { event: "b", data: "p\nq", id: undefined },
    ]);
  });

  it("pushes decree.json changes to /api/events (live reload)", async () => {
    await start();
    const events: { event: string; data: string }[] = [];
    const ac = new AbortController();
    const res = await fetch(`${srv.url}api/events`, { headers: { [TOKEN_HEADER]: TOKEN }, signal: ac.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          events.splice(0, events.length, ...parseSSE(buf));
        }
      } catch {
        /* aborted */
      }
    })();
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(pred()).toBe(true);
    };
    await waitFor(() => events.some((e) => e.event === "hello"));
    await fs.writeFile(path.join(root, "decree.json"), stringifySpec({ ...sampleSpec(), goal: "changed on disk" }));
    await waitFor(() => events.some((e) => e.event === "spec"));
    const spec = JSON.parse(events.find((e) => e.event === "spec")!.data);
    expect(spec).toMatchObject({ source: "disk", ok: true });
    // A save from the UI is announced as such.
    await req("PATCH", "/api/spec", { body: { patch: { goal: "from the ui" } } });
    await waitFor(() => events.some((e) => e.event === "spec" && e.data.includes('"ui"')));
    ac.abort();
    await pump;
  });
});

describe("page", () => {
  it("embeds a client script that parses and is safe against </script> injection", () => {
    const html = renderPage({ token: 'a"b<c', nonce: "n1", projectName: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain('content="a&quot;b&lt;c"');
    const script = /<script nonce="n1">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
    const ls = String.fromCharCode(0x2028);
    const sj = scriptJson({ s: "</script><!--" + ls });
    expect(sj).not.toContain("<");
    expect(sj).not.toContain(ls);
    expect(clientScript({ a: 1 })).toContain("__decreeMarkdown");
  });

  it("makes no external requests: no http(s) URLs in src/href attributes", () => {
    const html = renderPage({ token: "t", nonce: "n", projectName: "p" });
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toMatch(/@import|url\(https?:/);
  });
});

describe("markdown renderer", () => {
  it("renders common markdown", () => {
    const html = renderMarkdown("# Role\nYou are **bold** and *it* with `code`.\n\n- a\n- b\n  - nested\n\n1. one\n2. two\n\n```ts\nconst x = 1 < 2;\n```\n\n> quote\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n---\n[link](https://example.com)");
    expect(html).toContain('<h1 id="md-role">Role</h1>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toMatch(/<ul><li>a<\/li><li>b<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain('<pre><code class="lang-ts">const x = 1 &lt; 2;</code></pre>');
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain('<th style="text-align:center">b</th>');
    expect(html).toContain("<hr>");
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>');
  });

  it("escapes HTML and refuses dangerous links", () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html,hi) [z](https://ok.example/?a="b"onmouseover=1)\n\n`<b>` **<i>**',
    );
    expect(html).not.toMatch(/<img|<script|<i>|<b>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data');
    expect(html).not.toMatch(/"onmouseover/);
    expect(html).toContain("<code>&lt;b&gt;</code>");
  });

  it("is self-contained so the page can embed it with toString()", () => {
    const fn = new Function(`return (${renderMarkdown.toString()})`)() as (s: string) => string;
    expect(fn("**hi**")).toBe("<p><strong>hi</strong></p>");
  });
});
