import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { Effort, JSONSchema, LLM, LLMUsage } from "../core/types.js";
import { DEFAULT_MODEL } from "../version.js";
import { readDotenvValue } from "./dotenv.js";
import { decodeJsonStrings, extractJson, schemaForPrompt, toStrictSchema } from "./schema.js";

export { parseDotenv, readDotenvValue } from "./dotenv.js";
export {
  JSON_STRING_KEY,
  decodeJsonStrings,
  extractJson,
  isJsonStringSchema,
  jsonStringField,
  schemaForPrompt,
  toStrictSchema,
} from "./schema.js";

export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_EFFORT: Effort = "high";

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Export it, add it to .env, or pass --offline.");
    this.name = "MissingApiKeyError";
  }
}

/** Friendly error wrapping an Anthropic SDK failure. `cause` holds the original error. */
export class LLMError extends Error {
  readonly status?: number;
  readonly kind: "auth" | "permission" | "not_found" | "rate_limit" | "overloaded" | "server" | "network" | "timeout" | "bad_request" | "aborted" | "refusal" | "max_tokens" | "parse" | "unknown";
  constructor(kind: LLMError["kind"], message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LLMError";
    this.kind = kind;
    this.status = opts.status;
  }
}

/** Resolve the Anthropic API key: explicit > ANTHROPIC_API_KEY env > `.env.local` / `.env` in cwd. */
export function resolveApiKey(explicit?: string, cwd: string = process.cwd()): string | undefined {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return clean(explicit) ?? clean(process.env.ANTHROPIC_API_KEY) ?? readDotenvValue("ANTHROPIC_API_KEY", cwd);
}

/**
 * The slice of the Anthropic client this module uses. Tests inject a fake via
 * `createLLM({ apiKey, client })`; see test/helpers/mock-llm.ts for a higher-level MockLLM.
 */
export interface StreamingClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams): {
      on(event: "text" | "thinking", listener: (delta: string, snapshot: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export interface CreateLLMOptions {
  apiKey?: string;
  model?: string;
  /** Test seam: a fake Anthropic client. When set, no real client is constructed. */
  client?: StreamingClient;
}

export function createLLM(opts: CreateLLMOptions = {}): LLM {
  const apiKey = resolveApiKey(opts.apiKey);
  if (!apiKey) throw new MissingApiKeyError();
  const client: StreamingClient =
    opts.client ?? (new Anthropic({ apiKey, authToken: null, maxRetries: 4 }) as unknown as StreamingClient);
  return new AnthropicLLM(client, opts.model?.trim() || DEFAULT_MODEL);
}

type TextOpts = Parameters<LLM["generateText"]>[0];
type JSONOpts = Parameters<LLM["generateJSON"]>[0];

class AnthropicLLM implements LLM {
  private totals: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Set once the API rejects a structured-output schema; later calls go straight to prompt mode. */
  private structuredUnsupported = false;

  constructor(
    private readonly client: StreamingClient,
    readonly model: string,
  ) {}

  usage(): LLMUsage {
    return { ...this.totals };
  }

  async generateText(opts: TextOpts): Promise<string> {
    return this.call({ ...opts });
  }

  async generateJSON<T>(opts: JSONOpts): Promise<T> {
    const { schema } = opts;
    if (!this.structuredUnsupported) {
      const strict = toStrictSchema(schema);
      try {
        return await this.withParseRetry<T>(opts, (prompt) => this.call({ ...opts, prompt, format: strict }));
      } catch (err) {
        if (!isSchemaRejection(err)) throw err;
        this.structuredUnsupported = true;
      }
    }
    // Fallback: plain text with the schema embedded in the prompt.
    const shown = JSON.stringify(schemaForPrompt(schema), null, 2);
    const fallbackPrompt =
      `${opts.prompt}\n\n` +
      `Respond with a single JSON value that conforms to this JSON Schema. Output only the JSON, ` +
      `no prose, optionally inside one \`\`\`json fence.\n\n\`\`\`json\n${shown}\n\`\`\``;
    return this.withParseRetry<T>({ ...opts, prompt: fallbackPrompt }, (prompt) => this.call({ ...opts, prompt }));
  }

  /** Run `invoke`, parse + decode; on a parse failure retry once with the error appended. */
  private async withParseRetry<T>(opts: JSONOpts, invoke: (prompt: string) => Promise<string>): Promise<T> {
    let prompt = opts.prompt;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await invoke(prompt);
      try {
        return parseJsonResponse<T>(text, opts.schema);
      } catch (err) {
        lastErr = err;
        prompt =
          `${opts.prompt}\n\n` +
          `Your previous response could not be used: ${(err as Error).message}\n` +
          `Return only valid JSON matching the schema. Fields described as JSON-encoded strings must contain valid JSON text.`;
      }
    }
    throw new LLMError("parse", `Model returned invalid JSON twice: ${(lastErr as Error).message}`, { cause: lastErr });
  }

  private async call(opts: TextOpts & { format?: JSONSchema }): Promise<string> {
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      output_config: {
        effort: opts.effort ?? DEFAULT_EFFORT,
        ...(opts.format ? { format: { type: "json_schema", schema: opts.format as Record<string, unknown> } } : {}),
      },
    };

    let message: Anthropic.Message;
    try {
      const stream = this.client.messages.stream(params);
      if (opts.onProgress) {
        let chars = 0;
        const onDelta = (delta: string) => {
          chars += delta.length;
          try {
            opts.onProgress!(chars);
          } catch {
            // progress callbacks must never break generation
          }
        };
        stream.on("text", onDelta);
        stream.on("thinking", onDelta);
      }
      message = await stream.finalMessage();
    } catch (err) {
      throw mapError(err);
    }

    this.addUsage(message.usage);

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    switch (message.stop_reason) {
      case "refusal": {
        const d = message.stop_details;
        const detail = d ? [d.category && `category: ${d.category}`, d.explanation].filter(Boolean).join("; ") : "";
        throw new LLMError("refusal", `Claude declined this request${detail ? ` (${detail})` : ""}.`);
      }
      case "max_tokens":
        throw new LLMError(
          "max_tokens",
          `Claude's response was cut off at max_tokens (${params.max_tokens}). Try a smaller project scope or a larger maxTokens.`,
        );
      case "model_context_window_exceeded":
        throw new LLMError("max_tokens", "The request exceeded the model's context window. Reduce the amount of project context sent.");
      default:
        return text;
    }
  }

  private addUsage(u: Anthropic.Usage | null | undefined) {
    if (!u) return;
    this.totals.inputTokens += u.input_tokens ?? 0;
    this.totals.outputTokens += u.output_tokens ?? 0;
    this.totals.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.totals.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  }
}

/** Parse model text as JSON (strict first, then tolerant extraction) and decode x-json-string fields. */
export function parseJsonResponse<T>(text: string, schema: JSONSchema): T {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    value = extractJson(text);
    if (value === undefined) {
      const preview = text.trim().slice(0, 200);
      throw new Error(`response was not valid JSON${preview ? `: ${JSON.stringify(preview)}` : " (empty response)"}`);
    }
  }
  return decodeJsonStrings<T>(value, schema);
}

function isSchemaRejection(err: unknown): boolean {
  const raw = err instanceof LLMError ? err.cause : err;
  if (!(raw instanceof BadRequestError)) return false;
  return /schema|output_config|format|structured/i.test(raw.message);
}

function apiMessage(err: APIError): string {
  // APIError.message is "<status> <json>"; prefer the inner error message when present.
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const inner = body?.error?.message;
  return typeof inner === "string" && inner ? inner : err.message;
}

/** Map SDK errors (most specific class first) to friendly LLMErrors. Non-SDK errors pass through. */
export function mapError(err: unknown): unknown {
  if (err instanceof LLMError) return err;
  if (err instanceof APIUserAbortError) return new LLMError("aborted", "Request to Claude was aborted.", { cause: err });
  if (err instanceof APIConnectionTimeoutError)
    return new LLMError("timeout", "Request to the Anthropic API timed out. Check your network and try again.", { cause: err });
  if (err instanceof APIConnectionError)
    return new LLMError(
      "network",
      "Could not reach the Anthropic API (network error). Check your internet connection or proxy settings, or pass --offline.",
      { cause: err },
    );
  if (err instanceof AuthenticationError)
    return new LLMError(
      "auth",
      "Invalid ANTHROPIC_API_KEY: the Anthropic API rejected it (401). Check the key at https://platform.claude.com/settings/keys.",
      { status: 401, cause: err },
    );
  if (err instanceof PermissionDeniedError)
    return new LLMError("permission", `Your Anthropic API key is not allowed to do this: ${apiMessage(err)}`, { status: 403, cause: err });
  if (err instanceof NotFoundError)
    return new LLMError("not_found", `Anthropic API: ${apiMessage(err)} (is the model id correct and available to your organization?)`, {
      status: 404,
      cause: err,
    });
  if (err instanceof RateLimitError)
    return new LLMError("rate_limit", "Rate limited by the Anthropic API (429), even after retries. Wait a minute and try again.", {
      status: 429,
      cause: err,
    });
  if (err instanceof BadRequestError)
    return new LLMError("bad_request", `The Anthropic API rejected the request: ${apiMessage(err)}`, { status: 400, cause: err });
  if (err instanceof APIError && (err.status === 529 || err.type === "overloaded_error"))
    return new LLMError("overloaded", "The Anthropic API is overloaded right now (529), even after retries. Try again shortly.", {
      status: 529,
      cause: err,
    });
  if (err instanceof InternalServerError)
    return new LLMError("server", `Anthropic API server error (${err.status}). Try again shortly.`, { status: err.status, cause: err });
  if (err instanceof APIError)
    return new LLMError("unknown", `Anthropic API error${err.status ? ` (${err.status})` : ""}: ${apiMessage(err)}`, {
      status: err.status,
      cause: err,
    });
  return err;
}
