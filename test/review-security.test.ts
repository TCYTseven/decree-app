// Regression tests for issues found in the security / correctness review.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessSpec, ToolSpec } from "../src/core/types.js";
import { writeFiles } from "../src/core/writer.js";
import { generateMcp } from "../src/generators/mcp/index.js";
import { generatePython } from "../src/generators/python/index.js";
import { generateTypescript } from "../src/generators/typescript/index.js";
import { prepareHttpRequest } from "../src/runtime/tools/http.js";
import { sampleSpec } from "./helpers/sample-spec.js";

vi.mock("../src/llm/pricing.js", () => ({ estimateCostUsd: () => 0 }));
const { runAgentWithClient } = await import("../src/runtime/index.js");

const TMP = path.resolve("test/.tmp/review-security");
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Block = Record<string, unknown> & { type: string };
type Resp = { content: Block[]; stop_reason: string };

function fakeClient(script: Resp[]) {
  const calls: any[] = [];
  const api = {
    stream(body: any) {
      calls.push(JSON.parse(JSON.stringify(body)));
      const step = script.shift();
      return {
        on() {
          return this;
        },
        async finalMessage() {
          if (!step) throw new Error("script exhausted");
          return { usage: { input_tokens: 1, output_tokens: 1 }, ...step };
        },
      };
    },
  };
  return { client: { messages: api, beta: { messages: api } }, calls };
}

const noCtx = (over: Partial<HarnessSpec> = {}) =>
  sampleSpec({ context: { caching: false, compaction: false, contextEditing: false, memory: false }, ...over });

/** Every tool_use in an assistant message must be answered in the very next user message. */
function assertValidHistory(messages: { role: string; content: unknown }[]): void {
  messages.forEach((m, i) => {
    if (m.role === "assistant") expect(Array.isArray(m.content) ? m.content.length : String(m.content).length, `message ${i} empty`).toBeGreaterThan(0);
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    const ids = (m.content as Block[]).filter((b) => b.type === "tool_use").map((b) => b.id);
    const serverIds = new Set((m.content as Block[]).filter((b) => b.type === "server_tool_use").map((b) => b.id));
    for (const b of m.content as Block[]) {
      if (b.type.endsWith("_tool_result")) expect(serverIds.has(b.tool_use_id), "orphan server tool result").toBe(true);
    }
    if (!ids.length) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const answered = new Set((next!.content as Block[]).map((b) => b.tool_use_id));
    for (const id of ids) expect(answered.has(id), `tool_use ${String(id)} unanswered`).toBe(true);
  });
}

describe("runtime loop keeps history valid", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "decree-review-"));
    fs.writeFileSync(path.join(root, "a.txt"), "alpha");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("does not keep an empty assistant message", async () => {
    const { client } = fakeClient([
      { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }], stop_reason: "tool_use" },
      { content: [], stop_reason: "end_turn" },
    ]);
    const res = await runAgentWithClient(noCtx(), { projectRoot: root, prompt: "read a.txt", apiKey: "sk-test" }, client);
    assertValidHistory(res.messages as any);
    expect((res.messages.at(-1) as { role: string }).role).toBe("user");
  });

  it("drops unanswerable tool calls on other stop reasons (model_context_window_exceeded)", async () => {
    const { client } = fakeClient([
      {
        content: [
          { type: "text", text: "Reading" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } },
        ],
        stop_reason: "model_context_window_exceeded",
      },
    ]);
    const events: any[] = [];
    const res = await runAgentWithClient(noCtx(), { projectRoot: root, prompt: "go", apiKey: "sk-test", onEvent: (e) => events.push(e) }, client);
    assertValidHistory(res.messages as any);
    expect(res.toolCalls).toEqual([]);
    expect(events.some((e) => e.type === "error" && /not run/.test(e.message))).toBe(true);
  });

  it("max_tokens: strips server tool results together with their server_tool_use", async () => {
    const { client } = fakeClient([
      {
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
          { type: "text", text: "Partial answer" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
        ],
        stop_reason: "max_tokens",
      },
    ]);
    const res = await runAgentWithClient(noCtx(), { projectRoot: root, prompt: "go", apiKey: "sk-test" }, client);
    assertValidHistory(res.messages as any);
    expect(JSON.stringify(res.messages)).toContain("Partial answer");
  });

  it("always redacts ANTHROPIC_API_KEY from tool output, even when redactEnv omits it", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-review-secret-123";
    try {
      const echo: ToolSpec = {
        name: "print_env",
        description: "print env",
        kind: "shell",
        inputSchema: { type: "object", properties: {}, required: [] },
        shell: { command: "echo key=$ANTHROPIC_API_KEY" },
        readOnly: true,
        destructive: false,
        requiresApproval: false,
      };
      const base = noCtx();
      const spec = noCtx({ tools: [echo], subagents: [], guardrails: { ...base.guardrails, redactEnv: [] } });
      const { client, calls } = fakeClient([
        { content: [{ type: "tool_use", id: "t1", name: "print_env", input: {} }], stop_reason: "tool_use" },
        { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      ]);
      const res = await runAgentWithClient(spec, { projectRoot: root, prompt: "go", apiKey: "sk-test" }, client);
      expect(res.toolCalls[0]!.output).toContain("[REDACTED:ANTHROPIC_API_KEY]");
      expect(JSON.stringify(calls[1])).not.toContain("sk-ant-review-secret-123");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("http path parameters", () => {
  const getOrder = sampleSpec().tools.find((t) => t.name === "get_order")!;
  const ctx = { projectRoot: "/", spec: sampleSpec(), env: { ACME_BASE_URL: "http://api.test/v1" } };

  it("refuses '.' and '..' (the URL parser would resolve them as dot segments)", () => {
    for (const id of ["..", "."]) {
      expect(() => prepareHttpRequest(getOrder, { id }, ctx)).toThrow(/may not be/);
    }
    expect(prepareHttpRequest(getOrder, { id: "..a" }, ctx).url).toBe("http://api.test/v1/orders/..a");
    expect(prepareHttpRequest(getOrder, { id: "../x" }, ctx).url).toBe("http://api.test/v1/orders/..%2Fx");
  });
});

describe("writer --clean", () => {
  it("never deletes through a symlinked directory that leads outside outDir", async () => {
    const base = path.join(TMP, "writer");
    fs.rmSync(base, { recursive: true, force: true });
    const out = path.join(base, "project", "agent");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(out, "sub"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const manifestPath = path.join(base, "project", ".decree", "manifest.json");
    await writeFiles(out, [{ path: "sub/keep.txt", content: "generated" }], { manifestPath });
    // Replace the generated directory with a symlink to a directory holding an identical file.
    fs.rmSync(path.join(out, "sub"), { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "generated");
    fs.symlinkSync(outside, path.join(out, "sub"));
    const report = await writeFiles(out, [], { manifestPath, clean: true, force: true });
    expect(report.removed).toEqual([]);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generated code: dangling symlinks and dot segments
// ---------------------------------------------------------------------------

function renderTo(dir: string, files: { path: string; content: string }[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
}

function projectWithDanglingLink(name: string): { root: string; target: string } {
  const root = path.join(TMP, name, "project");
  const target = path.join(TMP, name, "outside", "pwned.txt");
  fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(target, path.join(root, "evil-link")); // dangling: target does not exist yet
  return { root, target };
}

describe("generated MCP server tools", () => {
  it("refuse writes through a dangling symlink and dot-segment path params", async () => {
    const { root, target } = projectWithDanglingLink("mcp");
    const dir = path.join(TMP, "mcp", "mcp-server");
    renderTo(dir, generateMcp(sampleSpec(), { outDir: "agent", decreeVersion: "0.1.0" }));
    process.env.DECREE_PROJECT_ROOT = root;
    process.env.ACME_BASE_URL = "http://127.0.0.1:9";
    try {
      const tools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools.ts")).href)) as {
        runTool(name: string, input: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }>;
      };
      const w = await tools.runTool("write_file", { path: "evil-link", content: "x" });
      expect(w.isError).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
      const ok = await tools.runTool("write_file", { path: "fine.txt", content: "x" });
      expect(ok.isError).toBeUndefined();
      const listed = await tools.runTool("list_files", { pattern: "**/*" });
      expect(listed.isError).toBeUndefined();
      const h = await tools.runTool("get_order", { id: ".." });
      expect(h.isError).toBe(true);
      expect(h.content[0]!.text).toMatch(/may not be/);
    } finally {
      delete process.env.DECREE_PROJECT_ROOT;
      delete process.env.ACME_BASE_URL;
    }
  });
});

describe("generated TypeScript tools", () => {
  it("refuse writes through a dangling symlink and dot-segment path params", async () => {
    const { root, target } = projectWithDanglingLink("ts");
    const dir = path.join(TMP, "ts", "typescript");
    renderTo(dir, generateTypescript(sampleSpec(), { outDir: "agent", decreeVersion: "0.1.0" }));
    process.env.PROJECT_ROOT = root;
    try {
      const fsTools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools/fs.ts")).href)) as {
        writeFile(input: Record<string, unknown>, b: { root: string }): Promise<{ output: string; isError: boolean }>;
      };
      const w = await fsTools.writeFile({ path: "evil-link", content: "x" }, { root: "." });
      expect(w.isError).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
      const ok = await fsTools.writeFile({ path: "fine.txt", content: "x" }, { root: "." });
      expect(ok.isError).toBe(false);
      const httpTools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools/http.ts")).href)) as {
        callHttp(input: Record<string, unknown>, b: Record<string, unknown>): Promise<{ output: string; isError: boolean }>;
      };
      const h = await httpTools.callHttp({ id: ".." }, { method: "GET", baseUrlEnv: "NOPE_UNSET", defaultBaseUrl: "http://127.0.0.1:9/v1", path: "/orders/{id}" });
      expect(h.isError).toBe(true);
      expect(h.output).toMatch(/may not be/);
    } finally {
      delete process.env.PROJECT_ROOT;
    }
  });
});

describe("generated Python tools", () => {
  it("build_request refuses dot-segment path params", () => {
    const dir = path.join(TMP, "py", "python");
    const files = generatePython(sampleSpec(), { outDir: "agent", decreeVersion: "0.1.0" });
    renderTo(dir, files);
    // Minimal httpx stub so the module imports without the real dependency.
    const stubs = path.join(TMP, "py", "stubs");
    fs.mkdirSync(stubs, { recursive: true });
    fs.writeFileSync(path.join(stubs, "httpx.py"), "class HTTPError(Exception):\n    pass\n\ndef request(**kw):\n    raise HTTPError('stub')\n");
    const pkg = files.find((f) => f.path.endsWith("/tools/http.py"))!.path.split("/")[0]!;
    const code = [
      `from ${pkg}.tools.http import build_request`,
      "b = {'method': 'GET', 'baseUrlEnv': 'NOPE_UNSET', 'defaultBaseUrl': 'http://h/v1', 'path': '/orders/{id}'}",
      "for v in ('..', '.'):",
      "    try:",
      "        build_request(b, {'id': v}); print('BUILT')",
      "    except ValueError as e:",
      "        print('REFUSED', e)",
      "print(build_request(b, {'id': '..a'})['url'])",
    ].join("\n");
    const res = spawnSync("python3", ["-c", code], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: `${dir}${path.delimiter}${stubs}`, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") return; // no python3
    expect(res.stderr).toBe("");
    expect(res.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(/^REFUSED/),
      expect.stringMatching(/^REFUSED/),
      "http://h/v1/orders/..a",
    ]);
  });
});
