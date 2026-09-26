/**
 * createLLM against a fake Messages API over real HTTP + SSE (the real SDK, no client injection).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLLM, LLMError, toStrictSchema } from "../src/llm/client.js";
import type { JSONSchema } from "../src/core/types.js";
import { estimateCostUsd } from "../src/llm/pricing.js";
import { jsonReply, startFakeAnthropic, strictSchemaProblems, textReply, type FakeAnthropic } from "./helpers/fake-anthropic.js";

let fake: FakeAnthropic;
const saved = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };

beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});
afterAll(async () => {
  await fake.close();
  if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.base;
  if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
});
afterEach(() => {
  fake.requests.length = 0;
  fake.setHandler(() => textReply("ok"));
});

const SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, description: "Name" },
    count: { type: "integer", minimum: 0 },
    kind: { type: "string", enum: ["a", "b"] },
    when: { type: "string", format: "date-time" },
    weird: { type: "string", format: "regex" },
    inputSchema: { type: "object", "x-json-string": true, description: "free-form" },
    meta: { type: "object", additionalProperties: true },
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["id", "ghost"] },
    },
    choice: { oneOf: [{ type: "string" }, { type: "object", properties: { x: { type: "number" } } }] },
  },
  required: ["name", "inputSchema"],
};

describe("createLLM over the wire", () => {
  it("sends a structured-output request the API would accept and decodes x-json-string fields", async () => {
    fake.setHandler(() =>
      jsonReply(
        { name: "orders", count: 2, kind: "a", inputSchema: JSON.stringify({ type: "object", properties: { id: { type: "string" } } }), meta: '{"k":1}', items: [{ id: "x", tags: [] }] },
        { usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } },
      ),
    );
    const llm = createLLM({ apiKey: "sk-ant-fake", model: "claude-opus-5" });
    let progress = 0;
    const out = await llm.generateJSON<any>({ system: "sys", prompt: "go", schema: SCHEMA, effort: "medium", maxTokens: 4000, onProgress: (n) => (progress = n) });
    expect(out.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(out.meta).toEqual({ k: 1 });
    expect(out.items[0].id).toBe("x");
    expect(progress).toBeGreaterThan(0);

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.url).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant-fake");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-beta"]).toBeUndefined();
    const b = req.body;
    expect(b.stream).toBe(true);
    expect(b.model).toBe("claude-opus-5");
    expect(b.max_tokens).toBe(4000);
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(b.system).toBe("sys");
    expect(b.messages).toEqual([{ role: "user", content: "go" }]);
    expect(b.output_config.effort).toBe("medium");
    expect(b.output_config.format.type).toBe("json_schema");
    const sent = b.output_config.format.schema;
    expect(sent).toEqual(toStrictSchema(SCHEMA));
    expect(strictSchemaProblems(sent).problems).toEqual([]);
    expect(sent.properties.inputSchema.type).toBe("string");
    expect(sent.properties.meta.type).toBe("string");
    expect(sent.properties.when.format).toBe("date-time");
    expect(sent.properties.weird.format).toBeUndefined();
    expect(sent.properties.choice.anyOf).toHaveLength(2);
    expect(sent.properties.items.items.required).toEqual(["id"]);
    // unsupported keywords were stripped
    expect(JSON.stringify(sent)).not.toMatch(/minLength|minimum|oneOf|x-json-string/);

    // usage accumulates from message_start + message_delta exactly once
    expect(llm.usage()).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10 });
    expect(estimateCostUsd(llm.model, llm.usage())).toBeCloseTo((1200 * 5 + 300 * 25 + 50 * 0.5 + 10 * 6.25) / 1e6, 10);
  });

  it("falls back to prompt mode when the API rejects the schema (400), and stays there", async () => {
    fake.setHandler((req) => {
      if (req.body.output_config?.format) return { status: 400, type: "invalid_request_error", message: "output_config.format.schema: Schema is too complex for compilation." };
      return textReply('Here you go:\n```json\n{"name":"n","inputSchema":{"type":"object"}}\n```');
    });
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const out = await llm.generateJSON<any>({ system: "s", prompt: "p", schema: SCHEMA });
    expect(out).toEqual({ name: "n", inputSchema: { type: "object" } });
    expect(fake.requests).toHaveLength(2); // 400s are not retried by the SDK
    expect(fake.requests[1]!.body.output_config.format).toBeUndefined();
    expect(fake.requests[1]!.body.output_config.effort).toBe("high");
    expect(fake.requests[1]!.body.messages[0].content).toContain("Respond with a single JSON value");
    expect(fake.requests[1]!.body.messages[0].content).not.toContain("x-json-string");
    await llm.generateJSON<any>({ system: "s", prompt: "p2", schema: SCHEMA });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]!.body.output_config.format).toBeUndefined();
  });

  it("does not treat an unrelated 400 as a schema rejection", async () => {
    fake.setHandler(() => ({ status: 400, type: "invalid_request_error", message: "messages: text content blocks must be non-empty" }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const err: any = await llm.generateJSON({ system: "s", prompt: "p", schema: SCHEMA }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("bad_request");
    expect(err.message).toContain("text content blocks must be non-empty");
    expect(fake.requests).toHaveLength(1);
  });

  it("maps 401 to a friendly auth error without retrying", async () => {
    fake.setHandler(() => ({ status: 401, type: "authentication_error", message: "invalid x-api-key" }));
    const llm = createLLM({ apiKey: "sk-ant-bad" });
    const err = await llm.generateText({ system: "s", prompt: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("auth");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Invalid ANTHROPIC_API_KEY/);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries 429 (honoring retry-after-ms) and succeeds", async () => {
    let n = 0;
    fake.setHandler(() => (n++ < 2 ? { status: 429, type: "rate_limit_error", message: "slow down", headers: { "retry-after-ms": "5" } } : textReply("hello")));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    expect(await llm.generateText({ system: "s", prompt: "p" })).toBe("hello");
    expect(fake.requests).toHaveLength(3);
  });

  it("surfaces persistent 429 as a rate_limit LLMError", async () => {
    fake.setHandler(() => ({ status: 429, type: "rate_limit_error", message: "slow down", headers: { "retry-after-ms": "1" } }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const err = await llm.generateText({ system: "s", prompt: "p" }).catch((e) => e);
    expect(err.kind).toBe("rate_limit");
    expect(fake.requests).toHaveLength(5); // 1 + maxRetries(4)
  });

  it("reports refusal with stop_details and truncation at max_tokens", async () => {
    fake.setHandler(() => ({ content: [{ type: "text", text: "" }], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "nope" } }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const r = await llm.generateText({ system: "s", prompt: "p" }).catch((e) => e);
    expect(r.kind).toBe("refusal");
    expect(r.message).toContain("category: cyber");
    fake.setHandler(() => ({ content: [{ type: "text", text: '{"name":' }], stop_reason: "max_tokens" }));
    const t: any = await llm.generateJSON({ system: "s", prompt: "p", schema: SCHEMA }).catch((e) => e);
    expect(t.kind).toBe("max_tokens");
  });

  it("retries once with the parse error when the JSON-string field is invalid", async () => {
    let n = 0;
    fake.setHandler(() => jsonReply(n++ === 0 ? { name: "a", inputSchema: "{not json" } : { name: "a", inputSchema: "{}" }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const out = await llm.generateJSON<any>({ system: "s", prompt: "p", schema: SCHEMA });
    expect(out.inputSchema).toEqual({});
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body.messages[0].content).toContain("could not be used");
    expect(fake.requests[1]!.body.output_config.format).toBeDefined();
  });
});
