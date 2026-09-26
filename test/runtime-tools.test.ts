import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ToolSpec } from "../src/core/types.js";
import { buildToolParams, executeTool, needsApproval } from "../src/runtime/index.js";
import { renderShellCommand, type ToolContext } from "../src/runtime/tools/index.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const spec = sampleSpec();
const tool = (name: string): ToolSpec => {
  const t = spec.tools.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t;
};

let root: string;
let outside: string;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ projectRoot: root, spec, ...extra });

beforeEach(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), "decree-rt-"));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  mkdirSync(path.join(root, "src/lib"), { recursive: true });
  writeFileSync(path.join(root, "src/index.ts"), "export const foo = 1;\nconst fooo = 2;\n");
  writeFileSync(path.join(root, "src/lib/util.ts"), "export function bar() { return 'foo'; }\n");
  writeFileSync(path.join(root, "README.md"), "# Proj\nfoo bar\n");
  mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/pkg/index.ts"), "foo");
  mkdirSync(path.join(root, ".venv/lib/site-packages"), { recursive: true });
  writeFileSync(path.join(root, ".venv/lib/site-packages/dep.py"), "foo = 1\n");
  writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01]));
});

describe("fs tools", () => {
  it("reads a file under the root", async () => {
    const r = await executeTool(tool("read_file"), { path: "src/index.ts" }, ctx());
    expect(r).toEqual({ output: "export const foo = 1;\nconst fooo = 2;\n", isError: false });
  });

  it("truncates reads at maxBytes", async () => {
    const small = { ...tool("read_file"), fs: { root: ".", maxBytes: 5 } };
    const r = await executeTool(small, { path: "README.md" }, ctx());
    expect(r.output).toMatch(/^# Pro\n…\[truncated \d+ bytes\]$/);
  });

  it("refuses ../ escapes, absolute paths and symlink escapes", async () => {
    for (const p of ["../outside/secret.txt", "src/../../outside/secret.txt", path.join(outside, "secret.txt"), "/etc/passwd"]) {
      const r = await executeTool(tool("read_file"), { path: p }, ctx());
      expect(r.isError, p).toBe(true);
      expect(r.output).toMatch(/Refused/);
    }
    symlinkSync(outside, path.join(root, "link"));
    const r = await executeTool(tool("read_file"), { path: "link/secret.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/symlink/);
    expect(r.output).not.toContain("TOP SECRET");

    const w = await executeTool(tool("write_file"), { path: "link/new.txt", content: "x" }, ctx());
    expect(w.isError).toBe(true);
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);

    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "file-link"));
    const w2 = await executeTool(tool("write_file"), { path: "file-link", content: "pwned" }, ctx());
    expect(w2.isError).toBe(true);
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
  });

  it("respects guardrails.allowedPaths", async () => {
    const narrow = sampleSpec({ guardrails: { ...spec.guardrails, allowedPaths: ["src"] } });
    const bad = await executeTool(tool("read_file"), { path: "README.md" }, { projectRoot: root, spec: narrow });
    expect(bad.isError).toBe(true);
    const good = await executeTool(tool("read_file"), { path: "src/index.ts" }, { projectRoot: root, spec: narrow });
    expect(good.isError).toBe(false);
  });

  it("writes files with mkdir -p, and describes instead in dry run", async () => {
    const r = await executeTool(tool("write_file"), { path: "out/deep/a.txt", content: "héllo" }, ctx());
    expect(r).toEqual({ output: "wrote 6 bytes to out/deep/a.txt", isError: false });
    expect(readFileSync(path.join(root, "out/deep/a.txt"), "utf8")).toBe("héllo");

    const d = await executeTool(tool("write_file"), { path: "dry.txt", content: "abc" }, ctx({ dryRun: true }));
    expect(d.output).toBe("[dry run] would write 3 bytes to dry.txt");
    expect(existsSync(path.join(root, "dry.txt"))).toBe(false);

    // read-only tools still execute in dry run
    const read = await executeTool(tool("read_file"), { path: "README.md" }, ctx({ dryRun: true }));
    expect(read.output).toContain("# Proj");
  });

  it("lists files, ignoring node_modules, and refuses escaping globs", async () => {
    const r = await executeTool(tool("list_files"), { pattern: "**/*.ts" }, ctx());
    expect(r.output.split("\n")).toEqual(["src/index.ts", "src/lib/util.ts"]);
    const bad = await executeTool(tool("list_files"), { pattern: "../**/*" }, ctx());
    expect(bad.isError).toBe(true);
    const none = await executeTool(tool("list_files"), { pattern: "**/*.py" }, ctx());
    expect(none.output).toMatch(/No files match/);
  });

  it("searches with a regex, skipping binaries and ignored dirs", async () => {
    const r = await executeTool(tool("search_code"), { query: "fo{2,}" }, ctx());
    const lines = r.output.split("\n");
    expect(lines).toContain("src/index.ts:1: export const foo = 1;");
    expect(lines).toContain("src/index.ts:2: const fooo = 2;");
    expect(lines).toContain("README.md:2: foo bar");
    expect(r.output).not.toContain("bin.dat");
    expect(r.output).not.toContain("node_modules");
    expect(r.output).not.toContain(".venv"); // virtualenvs would flood results on every Python project

    const scoped = await executeTool(tool("search_code"), { query: "foo", glob: "src/lib/**" }, ctx());
    expect(scoped.output).toBe("src/lib/util.ts:1: export function bar() { return 'foo'; }");
  });

  it("returns an error result for an invalid regex", async () => {
    const r = await executeTool(tool("search_code"), { query: "(unclosed" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Invalid regular expression/);
  });
});

describe("input validation", () => {
  it("rejects missing required keys and wrong primitive types", async () => {
    const r = await executeTool(tool("read_file"), {}, ctx());
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/missing required parameter "path"/);
    const t = await executeTool(tool("read_file"), { path: 42 }, ctx());
    expect(t.output).toMatch(/"path" must be string, got integer/);
    const e = await executeTool(tool("list_orders"), { status: "bogus" }, ctx());
    expect(e.output).toMatch(/must be one of/);
    const n = await executeTool(tool("read_file"), "not an object", ctx());
    expect(n.isError).toBe(true);
  });
});

describe("shell tool", () => {
  const shellTool = (command: string, extra: Partial<ToolSpec["shell"]> = {}): ToolSpec => ({
    name: "sh",
    description: "",
    kind: "shell",
    inputSchema: { type: "object", properties: { msg: { type: "string" }, opt: { type: "string" } } },
    shell: { command, ...extra },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
  });

  it("renders templates with quoting and drops missing params", () => {
    expect(renderShellCommand("npm test -- {{pattern}}", {})).toBe("npm test --");
    expect(renderShellCommand("a {{x}}  {{y}} b", { y: "it's" })).toBe(`a 'it'\\''s' b`);
    expect(renderShellCommand("echo {{x}}", { x: "two  spaces" })).toBe("echo 'two  spaces'");
  });

  it("keeps injected shell metacharacters inert", async () => {
    writeFileSync(path.join(root, "x"), "keep me");
    const payloads = ["'; rm -rf x; echo '", "$(rm -rf x)", "`rm -rf x`", "a\" ; rm -rf x #", "x && rm -rf x"];
    for (const msg of payloads) {
      const r = await executeTool(shellTool("printf '%s' {{msg}}"), { msg }, ctx());
      expect(r.isError, msg).toBe(false);
      expect(r.output).toBe(`exit code: 0\n${msg}`);
      expect(existsSync(path.join(root, "x"))).toBe(true);
    }
  });

  it("refuses blocked commands, even when the pattern comes from a param", async () => {
    const r = await executeTool(shellTool("echo {{msg}}"), { msg: "git push --force" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/blocked pattern "git push --force"/);
    const t = await executeTool(shellTool("rm -rf / --no-preserve-root"), {}, ctx());
    expect(t.isError).toBe(true);
  });

  it("reports non-zero exit codes and captures stderr", async () => {
    const r = await executeTool(shellTool("echo out; echo err 1>&2; exit 3"), {}, ctx());
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/^exit code: 3\n/);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("times out and kills the whole process group", async () => {
    const started = Date.now();
    // The background sleep keeps stdout open; only a process-group kill lets this return fast.
    const r = await executeTool(shellTool("sleep 20 & echo started; wait", { timeoutMs: 300 }), {}, ctx());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/^exit code: timeout/);
    expect(r.output).toContain("started");
  });

  it("keeps the last 30,000 chars of large output", async () => {
    const r = await executeTool(shellTool("i=0; while [ $i -lt 5000 ]; do echo line$i-xxxxxxxxxx; i=$((i+1)); done; echo END"), {}, ctx());
    expect(r.output.length).toBeLessThan(30_200);
    expect(r.output).toMatch(/…\[truncated \d+ chars\]/);
    expect(r.output.trimEnd().endsWith("END")).toBe(true);
  });

  it("runs in shell.cwd and describes in dry run", async () => {
    const r = await executeTool(shellTool("pwd", { cwd: "src" }), {}, ctx());
    expect(r.output.trim().endsWith("/src")).toBe(true);
    const d = await executeTool(shellTool("touch made"), {}, ctx({ dryRun: true }));
    expect(d.output).toBe("[dry run] would run `touch made` in .");
    expect(existsSync(path.join(root, "made"))).toBe(false);
    const esc = await executeTool(shellTool("pwd", { cwd: "../outside" }), {}, ctx());
    expect(esc.isError).toBe(true);
  });
});

describe("http tool", () => {
  let server: http.Server;
  let base: string;
  const seen: { method?: string; url?: string; auth?: string; ct?: string; xreq?: string; body: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ct: req.headers["content-type"], xreq: req.headers["x-request-id"] as string, body });
        if (req.url?.startsWith("/missing")) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("nope");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const env = () => ({ ACME_BASE_URL: base, ACME_API_TOKEN: "tok-secret-123456" });

  it("fills path params (encoded), query params and bearer auth; redacts secrets", async () => {
    const r = await executeTool(tool("get_order"), { id: "a/b c" }, ctx({ env: env() }));
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/^HTTP 200 OK\n/);
    const last = seen.at(-1)!;
    expect(last.url).toBe("/orders/a%2Fb%20c");
    expect(last.auth).toBe("Bearer tok-secret-123456");
    // Echoed auth header is scrubbed before reaching the model.
    expect(r.output).toContain("Bearer [REDACTED:ACME_API_TOKEN]");
    expect(r.output).not.toContain("tok-secret-123456");

    await executeTool(tool("list_orders"), { status: "pending", limit: 5 }, ctx({ env: env() }));
    expect(seen.at(-1)!.url).toBe("/orders?status=pending&limit=5");
    expect(seen.at(-1)!.body).toBe("");
  });

  it("sends remaining keys as a JSON body, or bodyParam, plus header params", async () => {
    await executeTool(tool("cancel_order"), { id: "7", reason: "dup" }, ctx({ env: env() }));
    let last = seen.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/orders/7/cancel");
    expect(last.ct).toBe("application/json");
    expect(JSON.parse(last.body)).toEqual({ reason: "dup" });

    const custom: ToolSpec = {
      ...tool("cancel_order"),
      inputSchema: { type: "object", properties: {} },
      http: { ...tool("cancel_order").http!, method: "PUT", path: "/things/{id}", bodyParam: "payload", headerParams: ["x-request-id"], auth: { type: "header", header: "X-Api-Key", env: "ACME_API_TOKEN" } },
    };
    await executeTool(custom, { id: "9", payload: [1, 2], "x-request-id": "req-1", ignored: true }, ctx({ env: env() }));
    last = seen.at(-1)!;
    expect(last.method).toBe("PUT");
    expect(JSON.parse(last.body)).toEqual([1, 2]);
    expect(last.xreq).toBe("req-1");
  });

  it("marks 4xx as errors and network failures as errors", async () => {
    const t: ToolSpec = { ...tool("get_order"), http: { ...tool("get_order").http!, path: "/missing/{id}" } };
    const r = await executeTool(t, { id: "1" }, ctx({ env: env() }));
    expect(r).toEqual({ output: "HTTP 404 Not Found\nnope", isError: true });

    const down = await executeTool(tool("get_order"), { id: "1" }, ctx({ env: { ACME_BASE_URL: "http://127.0.0.1:1" } }));
    expect(down.isError).toBe(true);
    expect(down.output).toMatch(/^HTTP request failed/);
    // Says what was called and why it failed (undici hides the code in err.cause).
    expect(down.output).toContain("GET http://127.0.0.1:1/");
    expect(down.output).toMatch(/fetch failed \(.+\)/); // e.g. "(bad port)" or "(ECONNREFUSED)"

    const noBase: ToolSpec = { ...tool("get_order"), http: { ...tool("get_order").http!, defaultBaseUrl: undefined } };
    const nb = await executeTool(noBase, { id: "1" }, ctx({ env: {} }));
    expect(nb.output).toMatch(/set ACME_BASE_URL/);
  });

  it("dry-runs non-GET requests but still executes GETs", async () => {
    const before = seen.length;
    const d = await executeTool(tool("cancel_order"), { id: "7", reason: "dup" }, ctx({ env: env(), dryRun: true }));
    expect(d.output).toBe(`[dry run] would POST ${base}orders/7/cancel with JSON body {"reason":"dup"}`);
    expect(seen.length).toBe(before);
    const g = await executeTool(tool("get_order"), { id: "7" }, ctx({ env: env(), dryRun: true }));
    expect(g.output).toMatch(/^HTTP 200/);
    expect(seen.length).toBe(before + 1);
  });
});

describe("memory tool", () => {
  const mem = tool("memory");
  const run = (input: Record<string, unknown>, extra: Partial<ToolContext> = {}) => executeTool(mem, input, ctx(extra));
  const memDir = () => path.join(root, ".decree/memory");

  it("implements view/create/str_replace/insert/rename/delete under .decree/memory", async () => {
    expect((await run({ command: "create", path: "/memories/notes/a.md", file_text: "one\ntwo\n" })).output).toBe(
      "File created successfully at: /memories/notes/a.md",
    );
    expect(readFileSync(path.join(memDir(), "notes/a.md"), "utf8")).toBe("one\ntwo\n");

    const dir = await run({ command: "view", path: "/memories" });
    expect(dir.output).toContain("/memories/notes/");
    expect(dir.output).toContain("/memories/notes/a.md");

    const file = await run({ command: "view", path: "/memories/notes/a.md" });
    expect(file.output).toContain("     1\tone\n     2\ttwo");
    const ranged = await run({ command: "view", path: "/memories/notes/a.md", view_range: [2, 2] });
    expect(ranged.output).toMatch(/2\ttwo$/);

    expect((await run({ command: "str_replace", path: "/memories/notes/a.md", old_str: "two", new_str: "TWO" })).isError).toBe(false);
    expect((await run({ command: "str_replace", path: "/memories/notes/a.md", old_str: "zzz", new_str: "x" })).isError).toBe(true);
    expect((await run({ command: "insert", path: "/memories/notes/a.md", insert_line: 1, insert_text: "one-and-a-half" })).isError).toBe(false);
    expect(readFileSync(path.join(memDir(), "notes/a.md"), "utf8")).toBe("one\none-and-a-half\nTWO\n");
    expect((await run({ command: "insert", path: "/memories/notes/a.md", insert_line: 99, insert_text: "x" })).isError).toBe(true);

    expect((await run({ command: "rename", old_path: "/memories/notes/a.md", new_path: "/memories/b.md" })).isError).toBe(false);
    expect(existsSync(path.join(memDir(), "b.md"))).toBe(true);
    expect((await run({ command: "delete", path: "/memories/b.md" })).output).toBe("Successfully deleted /memories/b.md");
    expect(existsSync(path.join(memDir(), "b.md"))).toBe(false);
    expect((await run({ command: "delete", path: "/memories" })).isError).toBe(true);
    expect((await run({ command: "bogus" })).isError).toBe(true);
    expect((await run({})).isError).toBe(true);
  });

  it("confines paths to the memory directory", async () => {
    for (const p of ["/memories/../../outside.txt", "/etc/passwd", "../x"]) {
      const r = await run({ command: "create", path: p, file_text: "x" });
      expect(r.isError, p).toBe(true);
      expect(r.output).toMatch(/Refused/);
    }
    mkdirSync(memDir(), { recursive: true });
    symlinkSync(outside, path.join(memDir(), "evil"));
    const r = await run({ command: "view", path: "/memories/evil/secret.txt" });
    expect(r.isError).toBe(true);
    expect(r.output).not.toContain("TOP SECRET");
  });

  it("describes writes in dry run but still views", async () => {
    const r = await run({ command: "create", path: "/memories/a.md", file_text: "x" }, { dryRun: true });
    expect(r.output).toMatch(/^\[dry run\] would create \/memories\/a.md/);
    expect(existsSync(path.join(memDir(), "a.md"))).toBe(false);
    expect((await run({ command: "view", path: "/memories" }, { dryRun: true })).isError).toBe(false);
  });
});

describe("tool params and approval", () => {
  it("builds Anthropic tool definitions in spec order, with server tools by type and delegate tools", () => {
    const params = buildToolParams(spec) as unknown as Record<string, unknown>[];
    expect(params.map((p) => p.name)).toEqual([
      "list_orders", "get_order", "cancel_order", "run_tests", "read_file", "write_file", "list_files", "search_code",
      "web_search", "memory", "delegate_to_test_triager",
    ]);
    expect(params[8]).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    expect(params[9]).toEqual({ type: "memory_20250818", name: "memory" });
    expect(params[2]).toMatchObject({ input_schema: { type: "object", required: ["id", "reason"] }, eager_input_streaming: true });
    expect(params[10]).toMatchObject({ description: spec.subagents[0].description, input_schema: { required: ["task"] } });
  });

  it("applies the approval rule", () => {
    const ro = tool("read_file");
    const destructive = tool("cancel_order");
    const mutating = { ...ro, readOnly: false };
    expect(needsApproval(destructive, "never")).toBe(false);
    expect(needsApproval(destructive, "destructive")).toBe(true);
    expect(needsApproval(mutating, "destructive")).toBe(false);
    expect(needsApproval(mutating, "always")).toBe(true);
    expect(needsApproval(ro, "always")).toBe(false);
    expect(needsApproval({ ...ro, requiresApproval: true }, "always")).toBe(true);
  });
});

afterAll(() => {
  try {
    rmSync(path.dirname(root), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
