/**
 * A fake Anthropic Messages API for wire-level tests.
 *
 * Starts a real HTTP server on 127.0.0.1:<ephemeral port> that implements `POST /v1/messages`
 * (and `/v1/messages?beta=true`) with the same SSE event sequence the real API sends:
 *
 *   message_start -> ping -> (content_block_start -> content_block_delta* -> content_block_stop)*
 *   -> message_delta (stop_reason + usage) -> message_stop
 *
 * Text streams as `text_delta` chunks, thinking as `thinking_delta` + `signature_delta`, and tool
 * inputs as `input_json_delta` fragments (split into several chunks, like eager input streaming).
 * Non-streaming requests (`stream` absent/false) get the assembled Message as JSON.
 *
 * Point the SDK at it with `new Anthropic({ baseURL: fake.url })` or `ANTHROPIC_BASE_URL=fake.url`.
 * Every request's parsed body, URL, and headers are recorded in `fake.requests`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  /** `input` is serialized and streamed as input_json_delta; `rawJson` overrides it (e.g. to send broken JSON). */
  | { type: "tool_use"; id?: string; name: string; input?: unknown; rawJson?: string }
  | { type: "server_tool_use"; id?: string; name: string; input?: unknown }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown };

export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface FakeReply {
  content: FakeBlock[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "refusal" | "stop_sequence" | "model_context_window_exceeded";
  stop_details?: Record<string, unknown> | null;
  usage?: Partial<FakeUsage>;
  /** Split text/tool JSON into chunks of this many chars (default 7) to exercise delta accumulation. */
  chunkSize?: number;
}

export interface FakeError {
  status: number;
  type?: string; // e.g. "invalid_request_error"
  message: string;
  headers?: Record<string, string>;
}

export type FakeResponse = FakeReply | FakeError;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  /** Raw body length in characters (useful for prompt-size checks). */
  size: number;
}

export type FakeHandler = (req: RecordedRequest, index: number) => FakeResponse | Promise<FakeResponse>;

export interface FakeAnthropic {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Replace the handler (default: pop the queue, else a short "ok" text reply). */
  setHandler(h: FakeHandler): void;
  /** Queue replies consumed in order by the default handler. */
  enqueue(...replies: FakeResponse[]): void;
  close(): Promise<void>;
}

export const DEFAULT_USAGE: FakeUsage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const isError = (r: FakeResponse): r is FakeError => typeof (r as FakeError).status === "number";

function chunks(s: string, size: number): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_fake${String(++idCounter).padStart(6, "0")}`;

/** The final content block as the API returns it in a non-streaming Message. */
function finalBlock(b: FakeBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text, citations: null };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, signature: b.signature ?? "sig_fake" };
    case "tool_use":
    case "server_tool_use":
      return { type: b.type, id: b.id ?? nextId(b.type === "tool_use" ? "toolu" : "srvtoolu"), name: b.name, input: b.input ?? {} };
    default:
      return { ...b };
  }
}

/** SSE events for one reply, in the order the real API emits them. */
export function sseEvents(reply: FakeReply, model: string): { event: string; data: unknown }[] {
  const size = reply.chunkSize ?? 7;
  const usage = { ...DEFAULT_USAGE, ...reply.usage };
  const id = nextId("msg");
  const ev: { event: string; data: unknown }[] = [];
  ev.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: usage.input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          output_tokens: 1,
          service_tier: "standard",
        },
      },
    },
  });
  ev.push({ event: "ping", data: { type: "ping" } });

  reply.content.forEach((b, index) => {
    const start = (content_block: unknown) => ev.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block } });
    const delta = (d: unknown) => ev.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: d } });
    switch (b.type) {
      case "text":
        start({ type: "text", text: "", citations: null });
        for (const t of chunks(b.text, size)) delta({ type: "text_delta", text: t });
        break;
      case "thinking":
        start({ type: "thinking", thinking: "", signature: "" });
        for (const t of chunks(b.thinking, size)) delta({ type: "thinking_delta", thinking: t });
        delta({ type: "signature_delta", signature: b.signature ?? "sig_fake" });
        break;
      case "redacted_thinking":
        start({ type: "redacted_thinking", data: b.data });
        break;
      case "tool_use":
      case "server_tool_use": {
        const tid = b.id ?? nextId(b.type === "tool_use" ? "toolu" : "srvtoolu");
        start({ type: b.type, id: tid, name: b.name, input: {} });
        const json = (b.type === "tool_use" ? b.rawJson : undefined) ?? JSON.stringify(b.input ?? {});
        for (const t of chunks(json, size)) delta({ type: "input_json_delta", partial_json: t });
        break;
      }
      default:
        start({ ...b });
    }
    ev.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });

  ev.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: reply.stop_reason ?? "end_turn", stop_sequence: null, stop_details: reply.stop_details ?? null },
      // The live API repeats the cumulative input/cache counters here; output_tokens is the final total.
      usage: {
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        output_tokens: usage.output_tokens,
      },
    },
  });
  ev.push({ event: "message_stop", data: { type: "message_stop" } });
  return ev;
}

export function textReply(text: string, over: Partial<FakeReply> = {}): FakeReply {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", ...over };
}

/** A JSON reply as structured outputs would return it: one text block holding the JSON. */
export function jsonReply(value: unknown, over: Partial<FakeReply> = {}): FakeReply {
  return { content: [{ type: "thinking", thinking: "Planning the answer." }, { type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn", chunkSize: 97, ...over };
}

export async function startFakeAnthropic(handler?: FakeHandler): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const queue: FakeResponse[] = [];
  let current: FakeHandler =
    handler ??
    (() => {
      const next = queue.shift();
      return next ?? textReply("ok");
    });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const pathname = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || pathname !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `Not found: ${req.method} ${req.url}` } }));
        return;
      }
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const rec: RecordedRequest = { method: req.method, url: req.url ?? "", headers: req.headers, body, size: raw.length };
      requests.push(rec);
      let reply: FakeResponse;
      try {
        reply = await current(rec, requests.length - 1);
      } catch (e) {
        reply = { status: 500, type: "api_error", message: `fake handler threw: ${(e as Error).message}` };
      }
      const reqId = nextId("req");
      if (isError(reply)) {
        res.writeHead(reply.status, { "content-type": "application/json", "request-id": reqId, ...(reply.headers ?? {}) });
        res.end(JSON.stringify({ type: "error", error: { type: reply.type ?? "invalid_request_error", message: reply.message }, request_id: reqId }));
        return;
      }
      const model = typeof body?.model === "string" ? body.model : "claude-opus-5";
      if (!body?.stream) {
        const usage = { ...DEFAULT_USAGE, ...reply.usage };
        res.writeHead(200, { "content-type": "application/json", "request-id": reqId });
        res.end(
          JSON.stringify({
            id: nextId("msg"),
            type: "message",
            role: "assistant",
            model,
            content: reply.content.map(finalBlock),
            stop_reason: reply.stop_reason ?? "end_turn",
            stop_sequence: null,
            stop_details: reply.stop_details ?? null,
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "request-id": reqId });
      for (const e of sseEvents(reply, model)) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler(h) {
      current = h;
    },
    enqueue(...replies) {
      queue.push(...replies);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Structured-outputs schema checks (mirrors the documented API limits)
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set([
  "type", "description", "title", "enum", "const", "anyOf", "allOf", "$ref", "$defs", "definitions",
  "properties", "required", "additionalProperties", "items", "format", "default", "minItems",
]);
const ALLOWED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/**
 * Problems the real API would reject in an `output_config.format` schema: objects not closed with
 * `additionalProperties: false`, `required` naming undeclared properties, unsupported keywords or
 * formats, and the explicit complexity limits (24 optional parameters, 16 union-typed parameters).
 * Also returns the counts so tests can watch the headroom.
 */
export function strictSchemaProblems(schema: unknown): { problems: string[]; optional: number; unions: number } {
  const problems: string[] = [];
  let optional = 0;
  let unions = 0;
  const walk = (s: any, path: string) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push(`${path}: not a schema object`);
      return;
    }
    for (const k of Object.keys(s)) if (!ALLOWED_KEYS.has(k)) problems.push(`${path}: unsupported keyword "${k}"`);
    if (s.format !== undefined && !ALLOWED_FORMATS.has(s.format)) problems.push(`${path}: unsupported format "${s.format}"`);
    if (s.minItems !== undefined && s.minItems !== 0 && s.minItems !== 1) problems.push(`${path}: minItems must be 0 or 1`);
    if (typeof s.$ref === "string" && !/^#\/(\$defs|definitions)\//.test(s.$ref)) problems.push(`${path}: external $ref`);
    if (Array.isArray(s.enum) && s.enum.some((v: unknown) => v !== null && typeof v === "object")) problems.push(`${path}: complex enum values`);
    const isObj = s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || s.properties !== undefined;
    if (isObj) {
      if (s.additionalProperties !== false) problems.push(`${path}: object without additionalProperties:false`);
      const props = s.properties ?? {};
      const req: string[] = Array.isArray(s.required) ? s.required : [];
      for (const r of req) if (!(r in props)) problems.push(`${path}: required "${r}" is not a declared property`);
      for (const [k, v] of Object.entries<any>(props)) {
        if (!req.includes(k)) optional++;
        if (v && (Array.isArray(v.anyOf) || Array.isArray(v.type))) unions++;
        walk(v, `${path}.${k}`);
      }
    }
    if (s.items !== undefined) walk(s.items, `${path}[]`);
    for (const key of ["anyOf", "allOf"]) if (Array.isArray(s[key])) s[key].forEach((v: unknown, i: number) => walk(v, `${path}.${key}[${i}]`));
    for (const key of ["$defs", "definitions"]) if (s[key]) for (const [n, d] of Object.entries(s[key])) walk(d, `${path}.${key}.${n}`);
  };
  walk(schema, "$");
  if (optional > 24) problems.push(`${optional} optional parameters (API limit 24)`);
  if (unions > 16) problems.push(`${unions} union-typed parameters (API limit 16)`);
  return { problems, optional, unions };
}
