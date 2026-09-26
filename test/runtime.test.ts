import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { HarnessSpec, RuntimeEvent } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";

vi.mock("../src/llm/pricing.js", () => ({
  // $5 / $25 per 1M tokens, like opus-5.
  estimateCostUsd: (_model: string, u: { inputTokens: number; outputTokens: number }) => (u.inputTokens * 5 + u.outputTokens * 25) / 1e6,
}));
vi.mock("../src/llm/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/client.js")>()),
  resolveApiKey: () => undefined,
}));

const { runAgent, runAgentWithClient, DECLINED_MESSAGE } = await import("../src/runtime/index.js");
const { MissingApiKeyError } = await import("../src/llm/client.js");

// ---------------------------------------------------------------------------
// Scripted fake Anthropic client
// ---------------------------------------------------------------------------

type Block = Record<string, unknown> & { type: string };
type Resp = { content: Block[]; stop_reason: string; stop_details?: unknown; usage?: Record<string, number> };
type Step = Resp | ((body: any) => Resp | Promise<Resp>) | Error;

function fakeClient(script: Step[]) {
  const calls: { body: any; beta: boolean; options: any }[] = [];
  const make = (beta: boolean) => ({
    stream(body: any, options?: any) {
      calls.push({ body: JSON.parse(JSON.stringify(body)), beta, options });
      const step = script.shift();
      const listeners: Record<string, ((...a: any[]) => void)[]> = {};
      return {
        on(ev: string, fn: (...a: any[]) => void) {
          (listeners[ev] ??= []).push(fn);
          return this;
        },
        async finalMessage() {
          if (step === undefined) throw new Error("fake client: script exhausted");
          if (step instanceof Error) throw step;
          const resp = typeof step === "function" ? await step(body) : step;
          for (const b of resp.content) {
            if (b.type === "thinking") listeners.thinking?.forEach((fn) => fn(b.thinking));
            if (b.type === "text") listeners.text?.forEach((fn) => fn(b.text));
          }
          return { usage: { input_tokens: 100, output_tokens: 10 }, ...resp };
        },
      };
    },
  });
  return { client: { messages: make(false), beta: { messages: make(true) } }, calls };
}

const text = (t: string): Block => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const end = (t: string): Resp => ({ content: [text(t)], stop_reason: "end_turn" });
const toolTurn = (...blocks: Block[]): Resp => ({ content: blocks, stop_reason: "tool_use" });

let root: string;
const noCompaction = (overrides: Partial<HarnessSpec> = {}) =>
  sampleSpec({ context: { caching: true, compaction: false, contextEditing: false, memory: true }, ...overrides });

function collect() {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (e: RuntimeEvent) => events.push(e) };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "decree-loop-"));
  writeFileSync(path.join(root, "a.txt"), "alpha");
  writeFileSync(path.join(root, "b.txt"), "bravo");
});

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("agent loop", () => {
  it("runs tool_use -> tool_result -> end_turn and streams events", async () => {
    const { client, calls } = fakeClient([
      toolTurn(text("Let me look."), use("t1", "read_file", { path: "a.txt" })),
      end("The file says alpha."),
    ]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "what is in a.txt?", onEvent, apiKey: "sk-test-key-000" }, client);

    expect(res.finalText).toBe("The file says alpha.");
    expect(res.turns).toBe(2);
    expect(res.stopReason).toBe("end_turn");
    expect(res.toolCalls).toEqual([{ name: "read_file", input: { path: "a.txt" }, output: "alpha", isError: false }]);
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(res.costUsd).toBeCloseTo((200 * 5 + 20 * 25) / 1e6);

    const second = calls[1].body.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant" });
    expect(second.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "alpha" }] });
    expect(res.messages).toHaveLength(4);

    expect(events.map((e) => e.type)).toEqual(["text", "turn_end", "tool_call", "tool_result", "text", "turn_end", "done"]);

    const runs = readdirSync(path.join(root, ".decree/runs"));
    expect(runs).toHaveLength(1);
    const lines = readFileSync(path.join(root, ".decree/runs", runs[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].event.type).toBe("start");
    expect(lines.at(-1).event.type).toBe("done");
    expect(JSON.stringify(lines)).not.toContain("sk-test-key-000");
  });

  it("shapes the request per ARCHITECTURE (non-beta without compaction)", async () => {
    const { client, calls } = fakeClient([end("hi")]);
    await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "hi" }, client);
    const { body, beta, options } = calls[0];
    expect(beta).toBe(false);
    expect(options).toBeUndefined();
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(32000);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.system).toEqual([{ type: "text", text: sampleSpec().systemPrompt, cache_control: { type: "ephemeral" } }]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.betas).toBeUndefined();
    expect(body.tools.map((t: any) => t.name).at(-1)).toBe("delegate_to_test_triager");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("uses the beta endpoint for compaction/context editing; omits thinking when off", async () => {
    const { client, calls } = fakeClient([end("hi")]);
    const spec = sampleSpec({
      context: { caching: false, compaction: true, contextEditing: true, memory: false },
      model: { ...sampleSpec().model, thinking: "off" },
    });
    await runAgentWithClient(spec, { projectRoot: root, prompt: "hi", model: "claude-opus-5-5" }, client);
    const { body, beta } = calls[0];
    expect(beta).toBe(true);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.betas).toEqual(["context-management-2025-06-27", "compact-2026-01-12"]);
    expect(body.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }, { type: "compact_20260112" }] });
    expect(body.thinking).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
    expect(body.system[0].cache_control).toBeUndefined();
  });

  it("runs read-only tools concurrently and returns ALL results in ONE user message, in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = http.createServer((req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end(`order ${req.url}`);
      }, 150);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.ACME_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { client, calls } = fakeClient([
        toolTurn(
          use("t1", "get_order", { id: "1" }),
          use("t2", "read_file", { path: "b.txt" }),
          use("t3", "get_order", { id: "2" }),
          use("t4", "get_order", { id: "3" }),
        ),
        end("done"),
      ]);
      const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "go" }, client);
      expect(maxInFlight).toBe(3);
      const msgs = calls[1].body.messages;
      const last = msgs.at(-1);
      expect(last.role).toBe("user");
      expect(last.content.map((r: any) => r.tool_use_id)).toEqual(["t1", "t2", "t3", "t4"]);
      expect(last.content[0].content).toBe("HTTP 200 OK\norder /orders/1");
      expect(last.content[1].content).toBe("bravo");
      expect(last.content[3].content).toBe("HTTP 200 OK\norder /orders/3");
      expect(msgs.filter((m: any) => m.role === "user")).toHaveLength(2);
      expect(res.toolCalls).toHaveLength(4);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns the declined message when the approver says no", async () => {
    const approve = vi.fn(async () => false);
    const { client, calls } = fakeClient([toolTurn(use("c1", "cancel_order", { id: "7", reason: "dup" })), end("Okay, not cancelled.")]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "cancel 7", approve, onEvent }, client);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toMatchObject({ name: "cancel_order", input: { id: "7", reason: "dup" }, tool: { name: "cancel_order" } });
    expect(calls[1].body.messages.at(-1).content[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: DECLINED_MESSAGE, is_error: true });
    expect(events.some((e) => e.type === "approval_denied" && e.name === "cancel_order")).toBe(true);
    expect(res.toolCalls[0]).toMatchObject({ name: "cancel_order", isError: true });
  });

  it("denies destructive tools when no approver is provided", async () => {
    const { client, calls } = fakeClient([toolTurn(use("w1", "write_file", { path: "evil.txt", content: "x" })), end("ok")]);
    await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "write" }, client);
    expect(calls[1].body.messages.at(-1).content[0]).toMatchObject({ content: DECLINED_MESSAGE, is_error: true });
    expect(existsSync(path.join(root, "evil.txt"))).toBe(false);
  });

  it("dry run: approved side-effecting tools describe instead of executing", async () => {
    const { client, calls } = fakeClient([
      toolTurn(use("w1", "write_file", { path: "new.txt", content: "hello" }), use("s1", "run_tests", { pattern: "x" })),
      end("ok"),
    ]);
    await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "write", dryRun: true, approve: async () => true }, client);
    const results = calls[1].body.messages.at(-1).content;
    expect(results[0].content).toBe("[dry run] would write 5 bytes to new.txt");
    expect(results[1].content).toBe("[dry run] would run `npm test -- 'x'` in .");
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("validates tool input before running (and before asking for approval)", async () => {
    const approve = vi.fn(async () => true);
    const { client, calls } = fakeClient([toolTurn(use("c1", "cancel_order", { id: 7 }), use("u1", "no_such_tool", {})), end("ok")]);
    await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x", approve }, client);
    const results = calls[1].body.messages.at(-1).content;
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toMatch(/missing required parameter "reason"/);
    expect(results[0].content).toMatch(/"id" must be string/);
    expect(results[1]).toMatchObject({ is_error: true, content: "Unknown tool: no_such_tool" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("continues after pause_turn without adding a user message", async () => {
    const paused: Resp = {
      content: [
        text("Searching... "),
        { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "acme status" } },
        { type: "web_search_tool_result", tool_use_id: "srv1", content: [] },
      ],
      stop_reason: "pause_turn",
    };
    const { client, calls } = fakeClient([paused, end("All systems normal.")]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "status?", onEvent }, client);
    expect(calls).toHaveLength(2);
    const msgs = calls[1].body.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: "assistant", content: paused.content });
    expect(res.finalText).toBe("Searching... \n\nAll systems normal.");
    expect(res.toolCalls.map((t) => t.name)).toEqual(["web_search"]);
    expect(events.some((e) => e.type === "tool_call" && e.name === "web_search")).toBe(true);
  });

  it("stops at max_tokens without running truncated tool calls", async () => {
    const { client, calls } = fakeClient([
      { content: [text("Writing"), use("w1", "write_file", { path: "half.txt" })], stop_reason: "max_tokens" },
    ]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x", approve: async () => true, onEvent }, client);
    expect(calls).toHaveLength(1);
    expect(res.stopReason).toBe("max_tokens");
    expect(res.toolCalls).toHaveLength(0);
    expect(existsSync(path.join(root, "half.txt"))).toBe(false);
    expect(events.some((e) => e.type === "error" && /max_tokens/.test(e.message))).toBe(true);
    // history stays valid: no dangling tool_use
    expect(JSON.stringify(res.messages)).not.toContain("tool_use");
  });

  it("stops on refusal and reports stop_details", async () => {
    const details = { category: "cyber", explanation: "Not allowed." };
    const { client } = fakeClient([{ content: [], stop_reason: "refusal", stop_details: details }]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x", onEvent }, client);
    expect(res.stopReason).toBe("refusal");
    const err = events.find((e) => e.type === "error") as any;
    expect(err.message).toBe("Model refused (category: cyber): Not allowed.");
    expect(err.stopDetails).toEqual(details);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("caps the loop at guardrails.maxTurns with a valid history", async () => {
    const loop = () => toolTurn(use(`t${Math.random()}`, "read_file", { path: "a.txt" }));
    const { client, calls } = fakeClient([loop(), loop(), loop(), loop()]);
    const spec = noCompaction({ guardrails: { ...sampleSpec().guardrails, maxTurns: 2 } });
    const res = await runAgentWithClient(spec, { projectRoot: root, prompt: "x" }, client);
    expect(calls).toHaveLength(2);
    expect(res.turns).toBe(2);
    expect(res.stopReason).toBe("max_turns");
    expect((res.messages.at(-1) as any).content[0].type).toBe("tool_result");
  });

  it("stops once estimated cost exceeds guardrails.maxCostUsd", async () => {
    const big = (id: string): Resp => ({ ...toolTurn(use(id, "read_file", { path: "a.txt" })), usage: { input_tokens: 1_000_000, output_tokens: 0 } });
    const { client, calls } = fakeClient([big("a"), big("b"), big("c")]);
    const spec = noCompaction({ guardrails: { ...sampleSpec().guardrails, maxCostUsd: 7 } });
    const res = await runAgentWithClient(spec, { projectRoot: root, prompt: "x" }, client);
    expect(calls).toHaveLength(2);
    expect(res.stopReason).toBe("max_cost");
    expect(res.costUsd).toBeCloseTo(10);
  });

  it("delegates to a subagent with its own prompt, tools, model and effort", async () => {
    const { client, calls } = fakeClient([
      toolTurn(use("d1", "delegate_to_test_triager", { task: "why does a.txt matter?" })),
      toolTurn(use("s1", "read_file", { path: "a.txt" })),
      end("Root cause: alpha."),
      end("The triager says: alpha."),
    ]);
    const { events, onEvent } = collect();
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "triage", onEvent }, client);

    const sub = calls[1].body;
    expect(sub.model).toBe("claude-sonnet-5");
    expect(sub.output_config).toEqual({ effort: "medium" });
    expect(sub.system[0].text).toBe(sampleSpec().subagents[0].systemPrompt);
    expect(sub.tools.map((t: any) => t.name)).toEqual(["run_tests", "read_file", "list_files", "search_code"]);
    expect(sub.messages).toEqual([{ role: "user", content: "why does a.txt matter?" }]);
    expect(calls[2].body.model).toBe("claude-sonnet-5");

    const mainResults = calls[3].body.messages.at(-1).content;
    expect(mainResults).toEqual([{ type: "tool_result", tool_use_id: "d1", content: "Root cause: alpha." }]);
    expect(res.finalText).toBe("The triager says: alpha.");
    expect(res.toolCalls.map((t) => t.name)).toEqual(["read_file", "delegate_to_test_triager"]);
    // subagent text is not streamed into the main transcript, but its tool calls are surfaced
    expect(events.filter((e) => e.type === "text").map((e: any) => e.text)).toEqual(["The triager says: alpha."]);
    expect(events.filter((e) => e.type === "tool_call").map((e: any) => e.name)).toEqual(["delegate_to_test_triager", "read_file"]);
    expect(res.usage.inputTokens).toBe(400);
  });

  it("redacts env secrets from tool output and transcripts", async () => {
    process.env.ACME_API_TOKEN = "supersecret-token-xyz";
    writeFileSync(path.join(root, "cfg.txt"), "token=supersecret-token-xyz");
    const { client, calls } = fakeClient([toolTurn(use("r1", "read_file", { path: "cfg.txt" })), end("done")]);
    await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x" }, client);
    expect(calls[1].body.messages.at(-1).content[0].content).toBe("token=[REDACTED:ACME_API_TOKEN]");
    const runs = readdirSync(path.join(root, ".decree/runs"));
    expect(readFileSync(path.join(root, ".decree/runs", runs[0]), "utf8")).not.toContain("supersecret-token-xyz");
  });

  it("continues from history and returns the full transcript", async () => {
    const history = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const { client, calls } = fakeClient([end("second answer")]);
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "again", history }, client);
    expect(calls[0].body.messages).toEqual([...history, { role: "user", content: "again" }]);
    expect(res.messages).toEqual([...history, { role: "user", content: "again" }, { role: "assistant", content: [text("second answer")] }]);
  });

  it("honors an abort signal", async () => {
    const ctrl = new AbortController();
    const { client, calls } = fakeClient([
      () => {
        ctrl.abort();
        return toolTurn(use("t1", "read_file", { path: "a.txt" }));
      },
      end("never"),
    ]);
    const res = await runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x", signal: ctrl.signal }, client);
    expect(res.stopReason).toBe("aborted");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.signal).toBe(ctrl.signal);
    expect((res.messages.at(-1) as any).content[0]).toMatchObject({ is_error: true });
  });

  it("emits an error event and rethrows API failures", async () => {
    const { client } = fakeClient([new Error("boom")]);
    const { events, onEvent } = collect();
    await expect(runAgentWithClient(noCompaction(), { projectRoot: root, prompt: "x", onEvent }, client)).rejects.toThrow("boom");
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("runAgent throws MissingApiKeyError without a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runAgent(noCompaction(), { projectRoot: root, prompt: "x" })).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
