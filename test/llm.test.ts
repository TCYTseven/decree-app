import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APIConnectionError, AuthenticationError, BadRequestError, RateLimitError, APIError } from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import {
  LLMError,
  MissingApiKeyError,
  createLLM,
  decodeJsonStrings,
  extractJson,
  jsonStringField,
  parseDotenv,
  resolveApiKey,
  toStrictSchema,
  type StreamingClient,
} from "../src/llm/client.js";
import { estimateCostUsd, formatUsd, priceFor } from "../src/llm/pricing.js";
import { MockLLM, mockLLM } from "./helpers/mock-llm.js";
import type { JSONSchema } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Fake Anthropic client
// ---------------------------------------------------------------------------

type Reply =
  | { text?: string; thinking?: string; stop_reason?: Anthropic.StopReason; stop_details?: unknown; usage?: Partial<Anthropic.Usage> }
  | Error;

function fakeClient(replies: Reply[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client: StreamingClient = {
    messages: {
      stream(params) {
        requests.push(structuredClone(params));
        const r = replies.shift();
        const listeners: Record<string, ((d: string, s: string) => void)[]> = {};
        return {
          on(event, fn) {
            (listeners[event] ??= []).push(fn);
            return this;
          },
          async finalMessage() {
            if (!r) throw new Error("fake client: no reply queued");
            if (r instanceof Error) throw r;
            const content: unknown[] = [];
            if (r.thinking) {
              for (const fn of listeners.thinking ?? []) fn(r.thinking, r.thinking);
              content.push({ type: "thinking", thinking: r.thinking, signature: "sig" });
            }
            const text = r.text ?? "";
            // emit text in two chunks
            const half = Math.floor(text.length / 2);
            for (const chunk of [text.slice(0, half), text.slice(half)]) {
              if (chunk) for (const fn of listeners.text ?? []) fn(chunk, chunk);
            }
            content.push({ type: "text", text, citations: null });
            return {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: params.model,
              content,
              stop_reason: r.stop_reason ?? "end_turn",
              stop_details: r.stop_details ?? null,
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 10,
                cache_creation_input_tokens: 5,
                ...r.usage,
              },
            } as unknown as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client, requests };
}

const h = () => new Headers();

// ---------------------------------------------------------------------------

describe("createLLM / generateText", () => {
  it("throws MissingApiKeyError without a key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "decree-nokey-"));
    delete process.env.ANTHROPIC_API_KEY;
    process.chdir(dir);
    try {
      expect(() => createLLM({})).toThrow(MissingApiKeyError);
    } finally {
      process.chdir(cwd);
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams with adaptive thinking, effort, defaults; concatenates text; reports progress; accumulates usage", async () => {
    const { client, requests } = fakeClient([{ text: "hello world", thinking: "hmm" }, { text: "again" }]);
    const llm = createLLM({ apiKey: "sk-test", client });
    expect(llm.model).toBe("claude-opus-5");
    const progress: number[] = [];
    const out = await llm.generateText({ system: "sys", prompt: "hi", onProgress: (n) => progress.push(n) });
    expect(out).toBe("hello world");
    expect(progress.at(-1)).toBe("hmm".length + "hello world".length);
    expect(requests[0]).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    });
    expect(requests[0]!.output_config).not.toHaveProperty("format");

    await llm.generateText({ system: "s", prompt: "p", effort: "low", maxTokens: 1000 });
    expect(requests[1]).toMatchObject({ max_tokens: 1000, output_config: { effort: "low" } });
    expect(llm.usage()).toEqual({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10 });
  });

  it("uses a custom model", async () => {
    const { client, requests } = fakeClient([{ text: "x" }]);
    const llm = createLLM({ apiKey: "k", model: "claude-sonnet-5", client });
    await llm.generateText({ system: "", prompt: "p" });
    expect(requests[0]!.model).toBe("claude-sonnet-5");
  });

  it("throws on refusal with stop_details", async () => {
    const { client } = fakeClient([{ text: "", stop_reason: "refusal", stop_details: { category: "cyber", explanation: "nope", type: "refusal" } }]);
    const llm = createLLM({ apiKey: "k", client });
    await expect(llm.generateText({ system: "", prompt: "p" })).rejects.toThrow(/declined.*cyber.*nope/);
  });

  it("throws on max_tokens", async () => {
    const { client } = fakeClient([{ text: "partial", stop_reason: "max_tokens" }]);
    const llm = createLLM({ apiKey: "k", client });
    await expect(llm.generateText({ system: "", prompt: "p" })).rejects.toThrow(/max_tokens/);
  });

  it("maps SDK errors to friendly messages", async () => {
    const cases: [Error, RegExp, LLMError["kind"]][] = [
      [new AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "401 invalid", h()), /Invalid ANTHROPIC_API_KEY/, "auth"],
      [new RateLimitError(429, {}, "429", h()), /Rate limited/, "rate_limit"],
      [APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "529 overloaded", h()), /overloaded/i, "overloaded"],
      [new APIConnectionError({ message: "ECONNRESET" }), /network/i, "network"],
    ];
    for (const [err, re, kind] of cases) {
      const { client } = fakeClient([err]);
      const llm = createLLM({ apiKey: "k", client });
      const p = llm.generateText({ system: "", prompt: "p" });
      await expect(p).rejects.toThrow(re);
      await p.catch((e) => {
        expect(e).toBeInstanceOf(LLMError);
        expect(e.kind).toBe(kind);
      });
    }
  });
});

describe("generateJSON", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, inputSchema: jsonStringField("Tool input JSON Schema") },
          required: ["name", "inputSchema"],
        },
      },
    },
    required: ["name", "tools"],
  };

  it("sends a strict json_schema and decodes x-json-string fields", async () => {
    const reply = JSON.stringify({ name: "a", tools: [{ name: "t", inputSchema: '{"type":"object","properties":{"id":{"type":"string"}}}' }] });
    const { client, requests } = fakeClient([{ text: reply }]);
    const llm = createLLM({ apiKey: "k", client });
    const out = await llm.generateJSON<any>({ system: "s", prompt: "p", schema, effort: "medium" });
    expect(out).toEqual({ name: "a", tools: [{ name: "t", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] });
    const oc = requests[0]!.output_config!;
    expect(oc.effort).toBe("medium");
    expect(oc.format).toMatchObject({ type: "json_schema" });
    const sent = oc.format!.schema as any;
    expect(sent.additionalProperties).toBe(false);
    expect(sent.properties.name).toEqual({ type: "string" });
    expect(sent.properties.tools.items.additionalProperties).toBe(false);
    expect(sent.properties.tools.items.properties.inputSchema.type).toBe("string");
  });

  it("retries once with the parse error appended", async () => {
    const good = JSON.stringify({ name: "a", tools: [] });
    const { client, requests } = fakeClient([{ text: "not json at all" }, { text: good }]);
    const llm = createLLM({ apiKey: "k", client });
    const out = await llm.generateJSON<any>({ system: "s", prompt: "PROMPT", schema });
    expect(out).toEqual({ name: "a", tools: [] });
    expect(requests).toHaveLength(2);
    expect((requests[1]!.messages[0]!.content as string)).toMatch(/^PROMPT[\s\S]*could not be used/);
  });

  it("retries when an x-json-string field is not valid JSON, then fails after two bad replies", async () => {
    const bad = JSON.stringify({ name: "a", tools: [{ name: "t", inputSchema: "{oops" }] });
    const { client } = fakeClient([{ text: bad }, { text: bad }]);
    const llm = createLLM({ apiKey: "k", client });
    await expect(llm.generateJSON({ system: "s", prompt: "p", schema })).rejects.toThrow(/invalid JSON twice.*inputSchema/);
  });

  it("falls back to prompt-embedded schema when the API rejects the schema", async () => {
    const rejection = new BadRequestError(400, { error: { message: "output_config.format.schema: unsupported keyword" } }, "400 schema", h());
    const fenced = 'Here you go:\n```json\n{"name":"b","tools":[{"name":"t","inputSchema":{"type":"object"}}]}\n```\nDone.';
    const { client, requests } = fakeClient([rejection, { text: fenced }, { text: '{"name":"c","tools":[]}' }]);
    const llm = createLLM({ apiKey: "k", client });
    const out = await llm.generateJSON<any>({ system: "s", prompt: "p", schema });
    expect(out).toEqual({ name: "b", tools: [{ name: "t", inputSchema: { type: "object" } }] });
    expect(requests[1]!.output_config).not.toHaveProperty("format");
    const prompt = requests[1]!.messages[0]!.content as string;
    expect(prompt).toContain('"inputSchema"');
    expect(prompt).not.toContain("x-json-string");
    // Subsequent calls skip structured outputs.
    await llm.generateJSON({ system: "s", prompt: "p", schema });
    expect(requests[2]!.output_config).not.toHaveProperty("format");
  });

  it("does not fall back on unrelated 400s", async () => {
    const err = new BadRequestError(400, { error: { message: "messages: roles must alternate" } }, "400 roles", h());
    const { client } = fakeClient([err]);
    const llm = createLLM({ apiKey: "k", client });
    await expect(llm.generateJSON({ system: "s", prompt: "p", schema })).rejects.toThrow(/rejected the request: messages: roles/);
  });
});

describe("toStrictSchema", () => {
  it("closes objects, strips unsupported keywords, keeps supported formats", () => {
    const s = toStrictSchema({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        slug: { type: "string", format: "slug", pattern: "^[a-z]+$", maxLength: 3 },
        n: { type: "integer", minimum: 0, maximum: 5, default: 1 },
        list: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        choice: { oneOf: [{ type: "string" }, { type: "object", properties: { a: { type: "number" } } }] },
        nested: { properties: { x: { type: "boolean" } }, required: ["x", "ghost"] },
      },
      required: ["when", "missing"],
      additionalProperties: true,
    });
    expect(s).toEqual({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        slug: { type: "string" },
        n: { type: "integer" },
        list: { type: "array", items: { type: "string" } },
        choice: { anyOf: [{ type: "string" }, { type: "object", properties: { a: { type: "number" } }, required: [], additionalProperties: false }] },
        nested: { type: "object", properties: { x: { type: "boolean" } }, required: ["x"], additionalProperties: false },
      },
      required: ["when"],
      additionalProperties: false,
    });
  });

  it("turns x-json-string and free-form objects into strings; keeps $defs/$ref", () => {
    const s = toStrictSchema({
      type: "object",
      properties: {
        a: { type: "object", "x-json-string": true, description: "JSON schema" },
        b: { type: "object" },
        c: { type: "object", additionalProperties: { type: "string" } },
        d: { type: "object", properties: {}, additionalProperties: false },
        e: { $ref: "#/$defs/E" },
      },
      $defs: { E: { type: "object", properties: { z: { type: "string" } } } },
    });
    const p = s.properties as any;
    expect(p.a.type).toBe("string");
    expect(p.a.description).toMatch(/^JSON schema .*JSON-encoded/);
    expect(p.b.type).toBe("string");
    expect(p.c.type).toBe("string");
    expect(p.d).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
    expect(p.e).toEqual({ $ref: "#/$defs/E" });
    expect((s as any).$defs.E.additionalProperties).toBe(false);
  });

  it("does not mutate its input", () => {
    const input: JSONSchema = { type: "object", properties: { a: { type: "object", "x-json-string": true } } };
    const copy = structuredClone(input);
    toStrictSchema(input);
    expect(input).toEqual(copy);
  });
});

describe("decodeJsonStrings", () => {
  it("decodes nested, array and $ref positions and leaves real objects alone", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        list: { type: "array", items: { $ref: "#/$defs/T" } },
        free: { type: "object" },
      },
      $defs: { T: { type: "object", properties: { s: jsonStringField() } } },
    };
    const out = decodeJsonStrings({ list: [{ s: '{"a":1}' }, { s: { b: 2 } }], free: "[1,2]" }, schema);
    expect(out).toEqual({ list: [{ s: { a: 1 } }, { s: { b: 2 } }], free: [1, 2] });
  });

  it("throws with a path on invalid JSON text", () => {
    expect(() => decodeJsonStrings({ x: "{bad" }, { type: "object", properties: { x: jsonStringField() } })).toThrow(/\$\.x/);
  });
});

describe("extractJson", () => {
  it("handles plain, fenced, prose-wrapped and nested JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("```json\n{\"a\": [1, 2]}\n```")).toEqual({ a: [1, 2] });
    expect(extractJson("Sure!\n```\n{\"b\":true}\n```")).toEqual({ b: true });
    expect(extractJson('Result: {"s": "has } brace and \\" quote", "n": {"m": 1}} trailing')).toEqual({ s: 'has } brace and " quote', n: { m: 1 } });
    expect(extractJson("text [1, {\"x\": 2}] end")).toEqual([1, { x: 2 }]);
    expect(extractJson("{not json} then {\"ok\":1}")).toEqual({ ok: 1 });
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("dotenv + resolveApiKey", () => {
  it("parses quotes, comments, export prefix, escapes", () => {
    const env = parseDotenv(
      [
        "# comment",
        "export A=1",
        "B = two words # inline comment",
        "C='single # not a comment'",
        'D="line\\nbreak \\"q\\""',
        "E=",
        "  F=spaced  ",
        'G="multi',
        'line"',
        "H=has#hash",
        "not a line",
      ].join("\r\n"),
    );
    expect(env).toEqual({ A: "1", B: "two words", C: "single # not a comment", D: 'line\nbreak "q"', E: "", F: "spaced", G: "multi\nline", H: "has#hash" });
  });

  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decree-env-"));
    saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("prefers explicit > env > .env.local > .env", () => {
    expect(resolveApiKey(undefined, dir)).toBeUndefined();
    writeFileSync(join(dir, ".env"), 'export ANTHROPIC_API_KEY="from-dotenv"\n');
    expect(resolveApiKey(undefined, dir)).toBe("from-dotenv");
    writeFileSync(join(dir, ".env.local"), "ANTHROPIC_API_KEY=from-local # c\n");
    expect(resolveApiKey(undefined, dir)).toBe("from-local");
    process.env.ANTHROPIC_API_KEY = "from-env";
    expect(resolveApiKey(undefined, dir)).toBe("from-env");
    expect(resolveApiKey("explicit", dir)).toBe("explicit");
    expect(resolveApiKey("  ", dir)).toBe("from-env");
  });
});

describe("pricing", () => {
  it("prices by prefix with opus-5 fallback", () => {
    expect(priceFor("claude-opus-5")).toEqual({ input: 5, output: 25 });
    expect(priceFor("claude-opus-5-5")).toEqual({ input: 4, output: 20 });
    expect(priceFor("claude-sonnet-5")).toEqual({ input: 2, output: 10 });
    expect(priceFor("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    expect(priceFor("claude-fable-5-1")).toEqual({ input: 10, output: 50 });
    expect(priceFor("something-else")).toEqual({ input: 5, output: 25 });
  });

  it("estimates cost including cache reads/writes", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(estimateCostUsd("claude-opus-5", usage)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
    expect(estimateCostUsd("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.003, 9);
  });

  it("formats USD", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00423)).toBe("$0.0042");
    expect(formatUsd(3.5)).toBe("$3.50");
    expect(formatUsd(1234)).toBe("$1,234.00");
  });
});

describe("MockLLM helper", () => {
  it("returns queued responses then handler results and records calls", async () => {
    const llm = new MockLLM(['{"a":1}', { b: 2 }], { handler: (kind) => (kind === "text" ? "handled" : { h: true }) });
    expect(await llm.generateJSON({ system: "", prompt: "1", schema: {} })).toEqual({ a: 1 });
    expect(await llm.generateText({ system: "", prompt: "2" })).toBe('{\n  "b": 2\n}');
    expect(await llm.generateText({ system: "", prompt: "3" })).toBe("handled");
    expect(await llm.generateJSON({ system: "", prompt: "4", schema: {} })).toEqual({ h: true });
    expect(llm.calls.map((c) => c.kind)).toEqual(["json", "text", "text", "json"]);
    expect(llm.lastCall()!.opts.prompt).toBe("4");
    expect(llm.usage().inputTokens).toBe(4000);
  });

  it("throws queued errors and errors when empty", async () => {
    const llm = mockLLM(new Error("boom"));
    await expect(llm.generateText({ system: "", prompt: "p" })).rejects.toThrow("boom");
    await expect(llm.generateText({ system: "", prompt: "p" })).rejects.toThrow(/no response queued/);
  });
});
