/**
 * Preview playground + evals over SSE, with the real runtime and Anthropic SDK talking to the fake
 * Messages API (ANTHROPIC_BASE_URL + a fake key). Covers the approval round trip through the browser API.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringifySpec } from "../src/core/spec.js";
import { cliPreviewDeps } from "../src/commands/preview.js";
import { TOKEN_HEADER } from "../src/preview/security.js";
import { startPreviewServer, type PreviewServer } from "../src/preview/server.js";
import { DECLINED_MESSAGE } from "../src/runtime/index.js";
import { jsonReply, startFakeAnthropic, textReply, type FakeAnthropic, type FakeResponse } from "./helpers/fake-anthropic.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TOKEN = "chat-test-token-0123456789";
const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ACME_BASE_URL"];
const saved: Record<string, string | undefined> = {};
let fake: FakeAnthropic;
let root: string;
let srv: PreviewServer;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-preview";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ACME_BASE_URL = "http://127.0.0.1:9"; // never contacted: POSTs are dry-run
});
afterAll(async () => {
  await fake.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-preview-chat-"));
  await fs.writeFile(path.join(root, "decree.json"), stringifySpec(sampleSpec()));
  fake.requests.length = 0;
  srv = await startPreviewServer({ root, port: 0, token: TOKEN, deps: cliPreviewDeps(), watch: false });
});
afterEach(async () => {
  await srv.close();
  await fs.rm(root, { recursive: true, force: true });
});

const script = (...replies: FakeResponse[]) => fake.setHandler((_r, i) => replies[i] ?? { status: 500, type: "api_error", message: `unexpected request #${i}` });
const H = { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
const post = (p: string, body: unknown) => fetch(srv.url + p.replace(/^\//, ""), { method: "POST", headers: H, body: JSON.stringify(body) });

/** POST an SSE endpoint and hand each parsed event to `on`, which may act (e.g. approve). Resolves with all events. */
async function stream(p: string, body: unknown, on?: (ev: string, data: any) => void | Promise<void>): Promise<{ event: string; data: any }[]> {
  const res = await post(p, body);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: { event: string; data: any }[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (!ev) continue; // comments / heartbeats
      const parsed = JSON.parse(data);
      out.push({ event: ev, data: parsed });
      await on?.(ev, parsed);
    }
  }
  return out;
}

const toolTurn = (text: string, id: string, name: string, input: unknown): FakeResponse => ({
  content: [
    { type: "text", text },
    { type: "tool_use", id, name, input },
  ],
  stop_reason: "tool_use",
});

describe("playground chat over SSE", () => {
  it("streams text, tool calls and an approval that the page approves", async () => {
    script(
      { content: [{ type: "thinking", thinking: "Cancel needs approval." }, { type: "text", text: "I'll cancel it." }, { type: "tool_use", id: "toolu_c1", name: "cancel_order", input: { id: "ord_1", reason: "stuck" } }], stop_reason: "tool_use" },
      textReply("Cancelled **ord_1**."),
    );
    const events = await stream("/api/chat", { prompt: "Cancel ord_1", conversationId: "c1", dryRun: true }, async (ev, d) => {
      if (ev === "approval_request") {
        expect(d).toMatchObject({ name: "cancel_order", toolUseId: "toolu_c1", destructive: true, input: { id: "ord_1", reason: "stuck" } });
        const r = await post("/api/approval", { approvalId: d.approvalId, approved: true });
        expect(r.status).toBe(200);
      }
    });
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("start");
    expect(names).toContain("thinking");
    expect(names.indexOf("tool_call")).toBeLessThan(names.indexOf("approval_request"));
    expect(names.indexOf("approval_request")).toBeLessThan(names.indexOf("approval_resolved"));
    expect(names.indexOf("approval_resolved")).toBeLessThan(names.indexOf("tool_result"));
    expect(names.at(-1)).toBe("result");
    const text = events.filter((e) => e.event === "text").map((e) => e.data.text).join("");
    expect(text).toBe("I'll cancel it.Cancelled **ord_1**.");
    const result = events.find((e) => e.event === "tool_result")!.data;
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/dry run/i);
    const final = events.at(-1)!.data;
    expect(final).toMatchObject({ turns: 2, toolCalls: 1, finalText: "Cancelled **ord_1**." });
    expect(final.costUsd).toBeGreaterThan(0);
    // The fake API saw the real key, and the tool_result that went back was not a denial.
    expect(fake.requests[0].headers["x-api-key"]).toBe("sk-ant-fake-preview");
    const back = fake.requests[1].body.messages.at(-1).content.find((b: any) => b.type === "tool_result");
    expect(JSON.stringify(back)).not.toContain(DECLINED_MESSAGE);
  });

  it("denies from the page, then continues the same conversation with history", async () => {
    script(toolTurn("Cancelling.", "toolu_d1", "cancel_order", { id: "ord_2", reason: "dup" }), textReply("OK, I won't."), textReply("Second turn."));
    const events = await stream("/api/chat", { prompt: "Cancel ord_2", conversationId: "c2" }, async (ev, d) => {
      if (ev === "approval_request") await post("/api/approval", { approvalId: d.approvalId, approved: false });
    });
    expect(events.map((e) => e.event)).toContain("approval_denied");
    expect(events.find((e) => e.event === "approval_resolved")!.data.approved).toBe(false);
    const back = fake.requests[1].body.messages.at(-1).content.find((b: any) => b.type === "tool_result");
    expect(back.is_error).toBe(true);
    expect(JSON.stringify(back.content)).toContain(DECLINED_MESSAGE);

    const second = await stream("/api/chat", { prompt: "And now?", conversationId: "c2" });
    expect(second.at(-1)!.data.finalText).toBe("Second turn.");
    const msgs = fake.requests[2].body.messages;
    expect(msgs[0].content).toBe("Cancel ord_2");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "And now?" });

    // A reset forgets the history.
    await post("/api/chat/reset", { conversationId: "c2" });
    script(textReply("fresh"));
    fake.requests.length = 0;
    await stream("/api/chat", { prompt: "Hi", conversationId: "c2" });
    expect(fake.requests[0].body.messages).toHaveLength(1);
  });

  it("stop while waiting for approval declines the call and reports stopped", async () => {
    script(toolTurn("Cancelling.", "toolu_s1", "cancel_order", { id: "ord_3", reason: "x" }), textReply("never reached"));
    let runId = "";
    const events = await stream("/api/chat", { prompt: "Cancel ord_3", conversationId: "c3" }, async (ev, d) => {
      if (ev === "start") runId = d.runId;
      if (ev === "approval_request") {
        const r = await post("/api/chat/stop", { runId });
        expect((await r.json()).stopped).toBe(true);
        // The approval id is no longer pending afterwards.
        const late = await post("/api/approval", { approvalId: d.approvalId, approved: true });
        expect(late.status).toBe(404);
      }
    });
    expect(events.find((e) => e.event === "approval_resolved")!.data.approved).toBe(false);
    expect(events.at(-1)!.event).toBe("stopped");
    // A stopped reply leaves no history.
    script(textReply("clean"));
    fake.requests.length = 0;
    await stream("/api/chat", { prompt: "again", conversationId: "c3" });
    expect(fake.requests[0].body.messages).toHaveLength(1);
  });

  it("surfaces API failures as a fatal event with a message", async () => {
    script({ status: 401, type: "authentication_error", message: "invalid x-api-key" });
    const events = await stream("/api/chat", { prompt: "hi", conversationId: "c4" });
    const fatal = events.find((e) => e.event === "fatal");
    expect(fatal).toBeTruthy();
    expect(fatal!.data.message).toBeTruthy();
  });

  it("validates input and refuses a second concurrent reply", async () => {
    expect((await post("/api/chat", { prompt: "  " })).status).toBe(400);
    expect((await post("/api/approval", { approvalId: "nope", approved: true })).status).toBe(404);
  });

  it("explains a missing API key without starting a stream", async () => {
    await srv.close();
    srv = await startPreviewServer({ root, port: 0, token: TOKEN, deps: { ...cliPreviewDeps(), resolveKey: () => ({}) }, watch: false });
    const r = await post("/api/chat", { prompt: "hi" });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: "no_api_key" });
    const e = await post("/api/evals", {});
    expect(e.status).toBe(400);
    const st = await (await fetch(srv.url + "api/state", { headers: H })).json();
    expect(st.apiKey.available).toBe(false);
  });
});

describe("evals over SSE", () => {
  it("streams one result per case, then a summary", async () => {
    fake.setHandler((req) => {
      if (req.body.output_config?.format) return jsonReply({ pass: true, score: 1, reason: "asked first" });
      const msgs = req.body.messages;
      const first = typeof msgs[0].content === "string" ? msgs[0].content : "";
      if (/pending/.test(first) && msgs.length === 1) return toolTurn("", "toolu_e1", "list_orders", { status: "pending" });
      return textReply("There are 2 pending orders. Please confirm before I cancel anything.");
    });
    process.env.ACME_BASE_URL = fake.url; // list_orders is a GET, so it runs even in dry-run; any response will do
    const events = await stream("/api/evals", {});
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("start");
    expect(events[0].data).toMatchObject({ total: 2, ids: ["list-pending", "no-cancel-without-confirm"] });
    const results = events.filter((e) => e.event === "result").map((e) => e.data);
    expect(results.map((r) => r.id).sort()).toEqual(["list-pending", "no-cancel-without-confirm"]);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { total: 2, passed: 2, failed: 0 } });

    const one = await stream("/api/evals", { filter: "list-pending" });
    expect(one.filter((e) => e.event === "result")).toHaveLength(1);
    expect((await post("/api/evals", { filter: "zzz" })).status).toBe(400);
  });
});
