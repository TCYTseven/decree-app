/**
 * MockLLM: an in-memory `LLM` for tests. No network, deterministic.
 *
 * Two ways to drive it (can be combined; the queue is consumed first):
 *
 *   1. Queue responses in call order:
 *
 *        const llm = new MockLLM([{ name: "x" }, "some text"]);
 *        await llm.generateJSON({ system, prompt, schema }); // -> { name: "x" }
 *        await llm.generateText({ system, prompt });          // -> "some text"
 *
 *      A queued string returned from generateJSON is JSON.parsed; a queued non-string returned from
 *      generateText is JSON.stringified. A queued `Error` instance is thrown instead (to test error paths).
 *      `mockLLM(...responses)` is shorthand for `new MockLLM(responses)`.
 *
 *   2. Compute responses with a handler:
 *
 *        const llm = new MockLLM((kind, opts) =>
 *          kind === "json" && opts.prompt.includes("plan") ? sampleSpec() : "ok");
 *
 *      The handler may be async and may throw.
 *
 * With neither (or once the queue is exhausted and there is no handler) calls reject with a clear error.
 *
 * Inspect what was asked with `llm.calls` (each has `kind` and the full `opts`), or
 * `llm.lastCall()` / `llm.callsOf("json")`. Usage is faked: every call adds `usagePerCall`
 * (default 1000 in / 500 out) so cost reporting code paths have numbers to work with.
 * `onProgress` is invoked once with the response length.
 *
 * NOTE: MockLLM does NOT apply the x-json-string decoding the real client does; queue already-decoded
 * values (e.g. `inputSchema` as an object) exactly as your code expects generateJSON to return them.
 */
import type { Effort, JSONSchema, LLM, LLMUsage } from "../../src/core/types.js";

export type MockCallKind = "json" | "text";

export interface MockCallOpts {
  system: string;
  prompt: string;
  schema?: JSONSchema;
  effort?: Effort;
  maxTokens?: number;
  onProgress?: (chars: number) => void;
}

export interface MockCall {
  kind: MockCallKind;
  opts: MockCallOpts;
}

export type MockHandler = (kind: MockCallKind, opts: MockCallOpts) => unknown | Promise<unknown>;

export class MockLLM implements LLM {
  readonly model: string;
  readonly calls: MockCall[] = [];
  usagePerCall: LLMUsage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private queue: unknown[];
  private handler?: MockHandler;
  private totals: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(responses: unknown[] | MockHandler = [], opts: { model?: string; handler?: MockHandler } = {}) {
    this.model = opts.model ?? "claude-opus-5";
    if (typeof responses === "function") {
      this.queue = [];
      this.handler = responses;
    } else {
      this.queue = [...responses];
      this.handler = opts.handler;
    }
  }

  /** Append more queued responses. */
  push(...responses: unknown[]): this {
    this.queue.push(...responses);
    return this;
  }

  /** Replace the handler used once the queue is empty. */
  setHandler(handler: MockHandler): this {
    this.handler = handler;
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  lastCall(): MockCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  callsOf(kind: MockCallKind): MockCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  usage(): LLMUsage {
    return { ...this.totals };
  }

  async generateJSON<T>(opts: MockCallOpts & { schema: JSONSchema }): Promise<T> {
    const v = await this.next("json", opts);
    const out = typeof v === "string" ? JSON.parse(v) : v;
    opts.onProgress?.(JSON.stringify(out ?? null).length);
    return structuredClone(out) as T;
  }

  async generateText(opts: MockCallOpts): Promise<string> {
    const v = await this.next("text", opts);
    const out = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    opts.onProgress?.(out.length);
    return out;
  }

  private async next(kind: MockCallKind, opts: MockCallOpts): Promise<unknown> {
    this.calls.push({ kind, opts });
    const u = this.usagePerCall;
    this.totals.inputTokens += u.inputTokens;
    this.totals.outputTokens += u.outputTokens;
    this.totals.cacheReadTokens += u.cacheReadTokens;
    this.totals.cacheWriteTokens += u.cacheWriteTokens;
    let v: unknown;
    if (this.queue.length) v = this.queue.shift();
    else if (this.handler) v = await this.handler(kind, opts);
    else throw new Error(`MockLLM: no response queued for ${kind} call #${this.calls.length} (prompt: ${opts.prompt.slice(0, 80)}...)`);
    if (v instanceof Error) throw v;
    return v;
  }
}

/** Shorthand: `mockLLM(a, b, c)` === `new MockLLM([a, b, c])`. */
export function mockLLM(...responses: unknown[]): MockLLM {
  return new MockLLM(responses);
}
