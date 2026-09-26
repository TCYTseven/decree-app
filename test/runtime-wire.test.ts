/**
 * runAgent with the real Anthropic SDK client talking to a fake Messages API over HTTP + SSE.
 * Also runs a tiny fake "Acme orders" API so http tools execute for real.
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HarnessSpec, RuntimeEvent } from "../src/core/types.js";
import { estimateCostUsd } from "../src/llm/pricing.js";
import { DECLINED_MESSAGE, runAgent } from "../src/runtime/index.js";
import { runEvalsWithClient } from "../src/eval/index.js";
import { createRuntimeClient } from "../src/runtime/index.js";
import { createLLM } from "../src/llm/client.js";
import { jsonReply, startFakeAnthropic, textReply, type FakeAnthropic, type FakeResponse, type RecordedRequest } from "./helpers/fake-anthropic.js";
import { sampleSpec } from "./helpers/sample-spec.js";

let fake: FakeAnthropic;
let acme: http.Server;
const acmeHits: { method: string; url: string; auth?: string; body: string }[] = [];
let root: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ACME_BASE_URL", "ACME_API_TOKEN", "ANTHROPIC_API_KEY"];

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  fake = await startFakeAnthropic();
  acme = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      acmeHits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url!.startsWith("/orders?")) res.end(JSON.stringify([{ id: "ord_1", status: "pending" }, { id: "ord_2", status: "pending" }]));
      else if (req.url === "/orders/ord_1") res.end(JSON.stringify({ id: "ord_1", status: "pending", total: 42 }));
      else res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((r) => acme.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_AUTH_TOKEN = "stray-token"; // must not leak into requests as a second credential
  process.env.ACME_BASE_URL = `http://127.0.0.1:${(acme.address() as AddressInfo).port}`;
  process.env.ACME_API_TOKEN = "acme-secret-token-123";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-runtime";
});
afterAll(async () => {
  await fake.close();
  acme.closeAllConnections?.();
  await new Promise<void>((r) => acme.close(() => r()));
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-rt-wire-"));
  fake.requests.length = 0;
  acmeHits.length = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const script = (...replies: FakeResponse[]) => fake.setHandler((_req, i) => replies[i] ?? { status: 500, type: "api_error", message: `unexpected request #${i}` });
const bodies = () => fake.requests.map((r) => r.body);
const lastMsg = (req: RecordedRequest) => req.body.messages.at(-1);

describe("runAgent over the wire", () => {
  it("streams a multi-turn run: parallel reads, approval-gated write, final answer; request shape is what the API expects", async () => {
    const spec = sampleSpec();
    script(
      {
        content: [
          { type: "thinking", thinking: "I should list pending orders and fetch ord_1 in parallel." },
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_a", name: "list_orders", input: { status: "pending", limit: 5 } },
          { type: "tool_use", id: "toolu_b", name: "get_order", input: { id: "ord_1" } },
        ],
        stop_reason: "tool_use",
        chunkSize: 3,
        usage: { input_tokens: 3000, output_tokens: 150, cache_creation_input_tokens: 2500, cache_read_input_tokens: 0 },
      },
      {
        content: [{ type: "tool_use", id: "toolu_c", name: "cancel_order", input: { id: "ord_1", reason: "Customer asked \"twice\" — ok" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 400, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 2500 },
      },
      textReply("There were 2 pending orders; ord_1 is now cancelled.", { usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 2900 } }),
    );
    const events: RuntimeEvent[] = [];
    const approvals: string[] = [];
    const res = await runAgent(spec, {
      projectRoot: root,
      prompt: "How many pending orders? Then cancel ord_1, the customer confirmed.",
      onEvent: (e) => events.push(e),
      approve: async ({ name }) => (approvals.push(name), true),
    });

    expect(res.stopReason).toBe("end_turn");
    expect(res.turns).toBe(3);
    expect(res.finalText).toBe("There were 2 pending orders; ord_1 is now cancelled.");
    expect(approvals).toEqual(["cancel_order"]);
    expect(res.toolCalls.map((t) => t.name)).toEqual(expect.arrayContaining(["list_orders", "get_order", "cancel_order"]));
    expect(res.toolCalls.find((t) => t.name === "list_orders")!.input).toEqual({ status: "pending", limit: 5 }); // reassembled from 3-char input_json_delta chunks
    expect(res.toolCalls.every((t) => !t.isError)).toBe(true);
    // The tools really ran against the Acme API, with the bearer token.
    expect(acmeHits.map((h) => `${h.method} ${h.url}`).sort()).toEqual(["GET /orders/ord_1", "GET /orders?status=pending&limit=5", "POST /orders/ord_1/cancel"].sort());
    expect(acmeHits.every((h) => h.auth === "Bearer acme-secret-token-123")).toBe(true);
    expect(JSON.parse(acmeHits.find((h) => h.method === "POST")!.body)).toEqual({ reason: 'Customer asked "twice" — ok' });

    // Streaming deltas reached the UI.
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toContain("Let me check.");
    expect(events.some((e) => e.type === "thinking")).toBe(true);

    // --- request shape -----------------------------------------------------------------
    expect(fake.requests).toHaveLength(3);
    for (const r of fake.requests) {
      expect(r.url).toBe("/v1/messages?beta=true"); // compaction is on -> beta endpoint
      expect(r.headers["anthropic-beta"]).toBe("compact-2026-01-12");
      expect(r.headers["x-api-key"]).toBe("sk-ant-fake-runtime");
      expect(r.headers.authorization).toBeUndefined();
      const b = r.body;
      expect(b.stream).toBe(true);
      expect(b.model).toBe("claude-opus-5");
      expect(b.max_tokens).toBe(32000);
      expect(b.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(b.output_config).toEqual({ effort: "high" });
      expect(b.cache_control).toEqual({ type: "ephemeral" });
      expect(b.system).toEqual([{ type: "text", text: spec.systemPrompt, cache_control: { type: "ephemeral" } }]);
      expect(b.betas).toBeUndefined(); // sent as a header, never in the body
      expect(b.context_management).toEqual({ edits: [{ type: "compact_20260112" }] });
    }
    const tools = fake.requests[0]!.body.tools as any[];
    expect(tools.find((t) => t.name === "web_search")).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    expect(tools.find((t) => t.name === "memory")).toEqual({ type: "memory_20250818", name: "memory" });
    const custom = tools.filter((t) => !t.type);
    expect(custom.map((t) => t.name)).toEqual(["list_orders", "get_order", "cancel_order", "run_tests", "read_file", "write_file", "list_files", "search_code", "delegate_to_test_triager"]);
    for (const t of custom) {
      expect(t.eager_input_streaming).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
    // Tools are byte-identical across turns (cache prefix stays stable).
    expect(JSON.stringify(fake.requests[2]!.body.tools)).toBe(JSON.stringify(tools));

    // Turn 2 replays the assistant turn exactly (thinking with signature, parsed tool inputs) + results in order.
    const t2 = fake.requests[1]!.body.messages;
    expect(t2).toHaveLength(3);
    expect(t2[1].role).toBe("assistant");
    expect(t2[1].content[0]).toEqual({ type: "thinking", thinking: "I should list pending orders and fetch ord_1 in parallel.", signature: "sig_fake" });
    expect(t2[1].content[2]).toEqual({ type: "tool_use", id: "toolu_a", name: "list_orders", input: { status: "pending", limit: 5 } });
    expect(JSON.stringify(t2)).not.toMatch(/__json_buf|parsed_output/);
    expect(t2[2].role).toBe("user");
    expect(t2[2].content.map((c: any) => [c.type, c.tool_use_id])).toEqual([
      ["tool_result", "toolu_a"],
      ["tool_result", "toolu_b"],
    ]);
    expect(t2[2].content[0].content).toContain("ord_2");
    // Secrets never go back to the model.
    expect(JSON.stringify(bodies())).not.toContain("acme-secret-token-123");

    // Usage and cost add up across turns.
    expect(res.usage).toEqual({ inputTokens: 3700, outputTokens: 250, cacheReadTokens: 5400, cacheWriteTokens: 2500 });
    expect(res.costUsd).toBeCloseTo(estimateCostUsd("claude-opus-5", res.usage), 12);
    const done = events.find((e) => e.type === "done") as Extract<RuntimeEvent, { type: "done" }>;
    expect(done.costUsd).toBe(res.costUsd);
  });

  it("declines a gated tool when approval is refused and tells the model", async () => {
    script(
      { content: [{ type: "tool_use", id: "toolu_x", name: "cancel_order", input: { id: "ord_9", reason: "x" } }], stop_reason: "tool_use" },
      textReply("Okay, I won't cancel it. Should I do something else?"),
    );
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "cancel ord_9", approve: async () => false });
    expect(acmeHits).toHaveLength(0);
    const result = lastMsg(fake.requests[1]!).content[0];
    expect(result).toEqual({ type: "tool_result", tool_use_id: "toolu_x", content: DECLINED_MESSAGE, is_error: true });
    expect(res.finalText).toMatch(/won't cancel/);
  });

  it("resumes pause_turn by resending the assistant turn with no extra user message", async () => {
    script(
      {
        content: [
          { type: "text", text: "Searching." },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "acme outage" } },
        ],
        stop_reason: "pause_turn",
      },
      textReply("No outage reported."),
    );
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "Is there an Acme outage?" });
    expect(res.finalText).toBe("Searching.\n\nNo outage reported."); // text before the pause is part of the same answer
    expect(res.toolCalls).toEqual([{ name: "web_search", input: { query: "acme outage" }, output: "(executed by Anthropic)", isError: false }]);
    const msgs = fake.requests[1]!.body.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content[1]).toEqual({ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "acme outage" } });
  });

  it("continues a chat from result.messages (history is valid request input)", async () => {
    script(
      { content: [{ type: "tool_use", id: "toolu_1", name: "get_order", input: { id: "ord_1" } }], stop_reason: "tool_use" },
      textReply("ord_1 is pending."),
      textReply("Its total is 42."),
    );
    const spec = sampleSpec({ context: { caching: true, compaction: false, contextEditing: false, memory: false } });
    const first = await runAgent(spec, { projectRoot: root, prompt: "status of ord_1?" });
    const second = await runAgent(spec, { projectRoot: root, prompt: "and the total?", history: first.messages });
    expect(second.finalText).toBe("Its total is 42.");
    const req = fake.requests[2]!;
    expect(req.url).toBe("/v1/messages"); // no betas -> GA endpoint
    expect(req.headers["anthropic-beta"]).toBeUndefined();
    expect(req.body.context_management).toBeUndefined();
    expect(req.body.messages).toHaveLength(5);
    expect(req.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(req.body.messages.slice(0, 4)).toEqual(JSON.parse(JSON.stringify(first.messages)));
    expect(req.body.messages[4]).toEqual({ role: "user", content: "and the total?" });
  });

  it("delegates to a subagent on its own model, effort, prompt, and tool subset", async () => {
    fake.setHandler((req) => {
      const sys = req.body.system[0].text as string;
      const turn = req.body.messages.length;
      if (sys.startsWith("You triage failing tests")) {
        if (turn === 1) return { content: [{ type: "tool_use", id: "toolu_s1", name: "read_file", input: { path: "package.json" } }], stop_reason: "tool_use" };
        return textReply("Root cause: none, the suite is fine.");
      }
      if (turn === 1) return { content: [{ type: "tool_use", id: "toolu_m1", name: "delegate_to_test_triager", input: { task: "Check why tests fail" } }], stop_reason: "tool_use" };
      return textReply("The triager found nothing wrong.");
    });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"x"}');
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "why are tests failing?" });
    expect(res.finalText).toBe("The triager found nothing wrong.");
    const sub = fake.requests.filter((r) => r.body.system[0].text.startsWith("You triage"));
    expect(sub).toHaveLength(2);
    expect(sub[0]!.body.model).toBe("claude-sonnet-5");
    expect(sub[0]!.body.output_config).toEqual({ effort: "medium" });
    expect(sub[0]!.body.tools.map((t: any) => t.name)).toEqual(["run_tests", "read_file", "list_files", "search_code"]);
    expect(sub[0]!.body.messages).toEqual([{ role: "user", content: "Check why tests fail" }]);
    expect(sub[1]!.body.messages[2].content[0].content).toContain('"name":"x"');
    const mainFinal = fake.requests.at(-1)!;
    expect(lastMsg(mainFinal).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_m1", content: "Root cause: none, the suite is fine." });
    // Subagent spend is priced on the subagent model and included in the total.
    expect(res.usage.inputTokens).toBe(4000);
  });

  it("re-issues a turn when a streamed tool input is not parseable JSON", async () => {
    script(
      { content: [{ type: "tool_use", id: "toolu_bad", name: "get_order", rawJson: '{"id" "ord_1"}' }], stop_reason: "tool_use" },
      textReply("Recovered."),
    );
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "get ord_1" });
    expect(res.finalText).toBe("Recovered.");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body.messages).toHaveLength(1); // the failed turn was not appended
    expect(acmeHits).toHaveLength(0);
  });

  it("returns a validation error (and does not run the tool) when the tolerant parser mangles an input", async () => {
    script(
      // The SDK's partial-JSON parser turns this into {"id": 1}: parseable, but wrong.
      { content: [{ type: "tool_use", id: "toolu_m", name: "get_order", rawJson: '{"id": ord_1}' }], stop_reason: "tool_use" },
      textReply("Retrying with a proper id."),
    );
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "get ord_1" });
    expect(acmeHits).toHaveLength(0);
    const result = lastMsg(fake.requests[1]!).content[0];
    expect(result.tool_use_id).toBe("toolu_m");
    expect(result.is_error).toBe(true);
    expect(res.toolCalls[0]!.isError).toBe(true);
  });

  it("does not run tools from a max_tokens-truncated turn", async () => {
    script({
      content: [
        { type: "text", text: "Cancelling" },
        { type: "tool_use", id: "toolu_t", name: "get_order", input: { id: "ord_" } },
      ],
      stop_reason: "max_tokens",
    });
    const events: RuntimeEvent[] = [];
    const res = await runAgent(sampleSpec(), { projectRoot: root, prompt: "x", onEvent: (e) => events.push(e) });
    expect(acmeHits).toHaveLength(0);
    expect(res.stopReason).toBe("max_tokens");
    expect(events.some((e) => e.type === "error" && /truncated tool call/.test(e.message))).toBe(true);
  });

  it("surfaces a 401 from the runtime as an SDK AuthenticationError", async () => {
    fake.setHandler(() => ({ status: 401, type: "authentication_error", message: "invalid x-api-key" }));
    await expect(runAgent(sampleSpec(), { projectRoot: root, prompt: "hi" })).rejects.toMatchObject({ status: 401 });
  });
});

describe("runEvals over the wire", () => {
  it("runs cases with dry-run tools and grades rubrics with the judge", async () => {
    fake.setHandler((req) => {
      if (req.body.output_config?.format) {
        expect(req.body.output_config.format.schema.additionalProperties).toBe(false);
        return jsonReply({ pass: true, score: 0.9, reason: "Asked for confirmation." });
      }
      const input = req.body.messages[0].content as string;
      if (input.startsWith("How many pending") && req.body.messages.length === 1)
        return { content: [{ type: "tool_use", id: "toolu_e1", name: "list_orders", input: { status: "pending" } }], stop_reason: "tool_use" };
      if (input.startsWith("How many pending")) return textReply("There are 2 pending orders.");
      return textReply("Please confirm you want to cancel order 123.");
    });
    const spec: HarnessSpec = sampleSpec();
    const judge = createLLM({ apiKey: "sk-ant-fake-runtime" });
    const results = await runEvalsWithClient(spec, { projectRoot: root, judge, concurrency: 2 }, createRuntimeClient("sk-ant-fake-runtime"));
    expect(results.map((r) => [r.id, r.passed])).toEqual([
      ["list-pending", true],
      ["no-cancel-without-confirm", true],
    ]);
    expect(results[1]!.checks.find((c) => c.name === "rubric")!.detail).toContain("score 0.90");
    const judgeReq = fake.requests.find((r) => r.body.output_config?.format)!;
    expect(judgeReq.body.output_config.effort).toBe("low");
    expect(judgeReq.body.max_tokens).toBe(2000);
  });
});
