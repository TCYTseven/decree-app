import { randomBytes } from "node:crypto";
import type { MessagesClientLike, ModelResponse, StreamLike } from "../runtime/loop.js";
import type { Dialect } from "./endpoints.js";

/**
 * A MessagesClientLike that talks to a local model, so decree's own agent loop (tools, approvals,
 * dry-run, subagents, redaction) runs unchanged against Ollama, LM Studio, llama.cpp, vLLM and
 * other OpenAI-compatible servers.
 *
 * The runtime builds an Anthropic Messages request; this adapter translates it to either
 * Ollama's native /api/chat (so `num_ctx` can be raised for long-context evals) or
 * OpenAI's /v1/chat/completions, and translates the answer back into Anthropic content blocks.
 * Requests are not streamed: `finalMessage()` resolves once the server answers.
 */

export interface LocalClientOptions {
  origin: string;
  dialect: Dialect;
  /** Always sent as the model, whatever the request names (subagents included). */
  model: string;
  apiKey?: string;
  /** Sampling temperature. 0 = greedy (default). */
  temperature?: number;
  seed?: number;
  /** Ollama only: context window to allocate for this request. */
  numCtx?: number;
  /** Upper bound on max_tokens, whatever the harness asks for. Default 2048. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Test seam. */
  fetch?: typeof fetch;
}

export type LocalErrorKind = "unreachable" | "no_tools" | "not_found" | "context" | "timeout" | "server" | "bad_response";

export class LocalModelError extends Error {
  constructor(
    public readonly kind: LocalErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LocalModelError";
  }
}

type Block = Record<string, unknown> & { type: string };

interface OAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

const newId = () => `toolu_local_${randomBytes(8).toString("hex")}`;

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => !!b && typeof b === "object" && typeof (b as Block).type === "string");
}

function textOfResult(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** Anthropic system + messages -> OpenAI-style chat messages (shared by both dialects). */
export function toChatMessages(body: Record<string, unknown>, dialect: Dialect): OAIMessage[] {
  const out: OAIMessage[] = [];
  const sys = body.system;
  const sysText = typeof sys === "string" ? sys : blocksOf(sys).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n\n");
  if (sysText.trim()) out.push({ role: "system", content: sysText });
  // Ollama's native API names the tool on a tool message instead of an id: remember names by id.
  const nameById = new Map<string, string>();
  for (const msg of (body.messages as { role: string; content: unknown }[]) ?? []) {
    const blocks = blocksOf(msg.content);
    if (msg.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      const calls = blocks.filter((b) => b.type === "tool_use");
      const m: OAIMessage = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) {
        m.tool_calls = calls.map((b) => {
          const id = String(b.id ?? newId());
          nameById.set(id, String(b.name ?? ""));
          return dialect === "ollama"
            ? { function: { name: String(b.name ?? ""), arguments: b.input ?? {} } }
            : { id, type: "function", function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) } };
        });
      }
      if (dialect === "ollama" && m.content === null) m.content = "";
      out.push(m);
      continue;
    }
    // user: tool results must come right after the assistant message that called them.
    const results = blocks.filter((b) => b.type === "tool_result");
    for (const r of results) {
      const id = String(r.tool_use_id ?? "");
      const text = textOfResult(r.content);
      const content = r.is_error ? `Error: ${text}` : text;
      out.push(dialect === "ollama" ? { role: "tool", content, tool_name: nameById.get(id) ?? "" } : { role: "tool", content, tool_call_id: id });
    }
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (text || !results.length) out.push({ role: "user", content: text });
  }
  return out;
}

/** Anthropic tool params -> OpenAI function tools. Server tools (web_search, memory) can't run locally. */
export function toChatTools(tools: unknown): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
  if (!Array.isArray(tools)) return [];
  const out: { type: "function"; function: { name: string; description: string; parameters: unknown } }[] = [];
  for (const t of tools as Record<string, unknown>[]) {
    if (!t || typeof t !== "object" || !t.input_schema || typeof t.name !== "string") continue;
    out.push({ type: "function", function: { name: t.name, description: String(t.description ?? ""), parameters: t.input_schema } });
  }
  return out;
}

/** Split reasoning from the answer: `<think>...</think>` (Qwen3, DeepSeek-R1) and a dangling `</think>`. */
export function splitThinking(text: string): { text: string; thinking: string } {
  let thinking = "";
  let rest = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, t: string) => {
    thinking += t;
    return "";
  });
  const dangling = rest.indexOf("</think>");
  if (dangling !== -1) {
    thinking += rest.slice(0, dangling);
    rest = rest.slice(dangling + "</think>".length);
  }
  const open = rest.search(/<think>/i);
  if (open !== -1) {
    thinking += rest.slice(open + 7);
    rest = rest.slice(0, open);
  }
  return { text: rest.trim(), thinking: thinking.trim() };
}

/**
 * Some models (and servers without a tool parser) put tool calls in the text as
 * `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` (Hermes / Qwen format). Recover those,
 * but only for tool names the request offered.
 */
export function extractTextToolCalls(text: string, toolNames: Set<string>): { text: string; calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, inner: string) => {
    try {
      const v = JSON.parse(inner) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof v.name === "string" && toolNames.has(v.name)) {
        calls.push({ name: v.name, input: parseArgs(v.arguments ?? v.parameters ?? {}) });
        return "";
      }
    } catch {
      /* not a tool call */
    }
    return whole;
  });
  return { text: rest.trim(), calls };
}

function parseArgs(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    // Invalid JSON: hand it through so validation reports it to the model, like a malformed call.
    return { _unparsed_arguments: raw };
  }
}

interface ParsedReply {
  text: string;
  thinking: string;
  calls: { id?: string; name: string; input: unknown }[];
  finish: string;
  inputTokens: number;
  outputTokens: number;
}

function parseOpenAI(json: unknown): ParsedReply {
  const j = json as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: OAIToolCall[] }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = j?.choices?.[0];
  if (!choice?.message) throw new LocalModelError("bad_response", "The server returned no choices.");
  const msg = choice.message;
  const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => (p as { text?: string }).text ?? "").join("") : "";
  const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : typeof msg.reasoning === "string" ? msg.reasoning : "";
  return {
    text: content,
    thinking: reasoning,
    calls: (msg.tool_calls ?? [])
      .filter((c) => c?.function?.name)
      .map((c) => ({ id: c.id, name: String(c.function!.name), input: parseArgs(c.function!.arguments) })),
    finish: String(choice.finish_reason ?? "stop"),
    inputTokens: Number(j.usage?.prompt_tokens) || 0,
    outputTokens: Number(j.usage?.completion_tokens) || 0,
  };
}

function parseOllama(json: unknown): ParsedReply {
  const j = json as {
    message?: { content?: unknown; thinking?: unknown; tool_calls?: OAIToolCall[] };
    done_reason?: unknown;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  if (!j?.message) throw new LocalModelError("bad_response", "Ollama returned no message.");
  return {
    text: typeof j.message.content === "string" ? j.message.content : "",
    thinking: typeof j.message.thinking === "string" ? j.message.thinking : "",
    calls: (j.message.tool_calls ?? [])
      .filter((c) => c?.function?.name)
      .map((c) => ({ id: c.id, name: String(c.function!.name), input: parseArgs(c.function!.arguments) })),
    finish: String(j.done_reason ?? "stop"),
    inputTokens: Number(j.prompt_eval_count) || 0,
    outputTokens: Number(j.eval_count) || 0,
  };
}

/** Build the HTTP request for one Anthropic-shaped body. Exported for tests. */
export function buildLocalRequest(body: Record<string, unknown>, opts: LocalClientOptions): { url: string; payload: Record<string, unknown> } {
  const messages = toChatMessages(body, opts.dialect);
  const tools = toChatTools(body.tools);
  const asked = Number(body.max_tokens) || 1024;
  const maxTokens = Math.max(16, Math.min(asked, opts.maxOutputTokens ?? 2048));
  const temperature = opts.temperature ?? 0;
  if (opts.dialect === "ollama") {
    return {
      url: `${opts.origin}/api/chat`,
      payload: {
        model: opts.model,
        messages,
        stream: false,
        ...(tools.length ? { tools } : {}),
        options: {
          temperature,
          num_predict: maxTokens,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        },
      },
    };
  }
  return {
    url: `${opts.origin}/v1/chat/completions`,
    payload: {
      model: opts.model,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    },
  };
}

/** Translate a parsed reply into the Anthropic response shape the agent loop expects. */
export function toModelResponse(reply: ParsedReply, toolNames: Set<string>): ModelResponse {
  const split = splitThinking(reply.text);
  let text = split.text;
  const thinking = [reply.thinking, split.thinking].filter(Boolean).join("\n").trim();
  let calls = reply.calls;
  if (!calls.length && toolNames.size) {
    const recovered = extractTextToolCalls(text, toolNames);
    if (recovered.calls.length) {
      calls = recovered.calls;
      text = recovered.text;
    }
  }
  const content: ModelResponse["content"] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "tool_use", id: c.id && /^[A-Za-z0-9_-]{1,64}$/.test(c.id) ? c.id : newId(), name: c.name, input: c.input ?? {} });
  const stop = calls.length ? "tool_use" : reply.finish === "length" ? "max_tokens" : "end_turn";
  return { content, stop_reason: stop, usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens } };
}

function classify(status: number, text: string, model: string): LocalModelError {
  const t = text.slice(0, 400);
  if (/does not support tools|tools? (are|is) not supported|tool[_ ]choice.*not supported|function calling is not (enabled|supported)/i.test(t))
    return new LocalModelError("no_tools", `${model} does not support tool calling on this server.`, status);
  if (status === 404 || /model .* not found|no such model|not found, try pulling/i.test(t))
    return new LocalModelError("not_found", `${model} is not available on this server (${t || `HTTP ${status}`}).`, status);
  if (/context (length|window|size)|too many tokens|exceeds? (the )?(maximum|context)|n_ctx/i.test(t))
    return new LocalModelError("context", `The request did not fit in ${model}'s context window (${t}).`, status);
  return new LocalModelError("server", `The local server answered HTTP ${status}: ${t || "(no body)"}`, status);
}

class LocalStream implements StreamLike {
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  private result?: Promise<ModelResponse>;

  constructor(
    private readonly run: () => Promise<ModelResponse>,
  ) {}

  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  finalMessage(): Promise<ModelResponse> {
    this.result ??= this.run().then((msg) => {
      // No token streaming: replay the whole answer as one delta so UIs still show it.
      for (const b of msg.content) {
        const kind = b.type === "text" ? "text" : b.type === "thinking" ? "thinking" : "";
        const value = b.type === "text" ? b.text : b.thinking;
        if (!kind || typeof value !== "string") continue;
        for (const l of this.listeners.get(kind) ?? []) {
          try {
            l(value, value);
          } catch {
            /* listeners must not break the run */
          }
        }
      }
      return msg;
    });
    return this.result;
  }
}

export function createLocalClient(opts: LocalClientOptions): MessagesClientLike {
  const f = opts.fetch ?? fetch;
  const send = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<ModelResponse> => {
    const { url, payload } = buildLocalRequest(body, opts);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: sig,
      });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (timeout.aborted) throw new LocalModelError("timeout", `${opts.model} did not answer within ${Math.round((opts.timeoutMs ?? 300_000) / 1000)}s.`);
      throw new LocalModelError("unreachable", `Could not reach ${opts.origin}: ${(err as Error).message}. Is the server still running?`);
    }
    const text = await res.text();
    if (!res.ok) throw classify(res.status, text, opts.model);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LocalModelError("bad_response", `The server did not return JSON: ${text.slice(0, 200)}`);
    }
    const err = (json as { error?: unknown }).error;
    if (err) throw classify(400, typeof err === "string" ? err : JSON.stringify(err), opts.model);
    const reply = opts.dialect === "ollama" ? parseOllama(json) : parseOpenAI(json);
    const names = new Set(toChatTools(body.tools).map((t) => t.function.name));
    return toModelResponse(reply, names);
  };
  const api = { stream: (body: any, options?: any) => new LocalStream(() => send(body as Record<string, unknown>, options?.signal as AbortSignal | undefined)) };
  // Context-editing betas have no local equivalent; the beta path behaves like the plain one.
  return { messages: api, beta: { messages: api } };
}

/** One plain chat turn (no tools): the text answer, reasoning removed. */
export async function chatOnce(
  client: MessagesClientLike,
  req: { system?: string; prompt?: string; messages?: { role: "user" | "assistant"; content: string }[]; maxTokens?: number; signal?: AbortSignal },
): Promise<{ text: string; inputTokens: number; outputTokens: number; stopReason: string | null }> {
  const messages = req.messages ?? [{ role: "user" as const, content: req.prompt ?? "" }];
  const body = { model: "local", max_tokens: req.maxTokens ?? 1024, system: req.system ?? "", messages };
  const msg = (await client.messages.stream(body, req.signal ? { signal: req.signal } : undefined).finalMessage()) as ModelResponse;
  const text = msg.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return { text, inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0, stopReason: msg.stop_reason };
}
