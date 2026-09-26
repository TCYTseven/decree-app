/** Static support modules of the generated project (no spec data). */

export function typesTs(): string {
  return `/** Shared types for the agent loop and its tools. */
import type Anthropic from "@anthropic-ai/sdk";
import type { Session, Usage } from "./session.js";

/** The tool shapes this harness declares: custom tools plus Anthropic-defined ones. */
export type ToolDefinition =
  | Anthropic.Beta.BetaTool
  | Anthropic.Beta.BetaWebSearchTool20260209
  | Anthropic.Beta.BetaWebFetchTool20260209
  | Anthropic.Beta.BetaMemoryTool20250818;

export interface ToolResult {
  output: string;
  isError: boolean;
}

/** Streamed progress. \`agent\` is set when the event comes from a subagent. */
export type AgentEvent = { agent?: string } & (
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean; ms: number }
  | { type: "approval_denied"; id: string; name: string }
  | { type: "turn_end"; turn: number; stopReason: string | null; usage: Usage }
  | { type: "notice"; message: string }
);

/** Asked before running a tool that needs approval; resolve true to allow it. */
export type Approver = (call: { name: string; input: unknown; tool: ToolEntry }) => Promise<boolean>;

/** What a running tool can reach besides its input (used by subagent delegation). */
export interface ToolContext {
  session: Session;
  approve: Approver;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface ToolEntry {
  definition: ToolDefinition;
  /** Read-only tools in the same turn run concurrently; the rest run one at a time. */
  readOnly: boolean;
  destructive: boolean;
  requiresApproval: boolean;
  /** Executes the tool locally. Absent for server tools, which Anthropic runs. */
  run?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
`;
}

export function sessionTs(): string {
  return `/** Usage and cost accounting for one run, shared by the main agent and its subagents. */
import type Anthropic from "@anthropic-ai/sdk";
import { GUARDRAILS } from "./config.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
  agent?: string;
}

/** USD per million tokens: [input, output]. Cache reads cost 0.1x input, cache writes 1.25x. */
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};
/** Used for model ids not in the table, so the cost cap still applies. */
const FALLBACK_PRICING: [number, number] = [5, 25];

export function estimateCostUsd(model: string, usage: Usage): number {
  const [input, output] = PRICING[model] ?? FALLBACK_PRICING;
  const inputCost =
    usage.inputTokens * input + usage.cacheReadTokens * input * 0.1 + usage.cacheWriteTokens * input * 1.25;
  return (inputCost + usage.outputTokens * output) / 1_000_000;
}

export class Session {
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  costUsd = 0;
  readonly toolCalls: ToolCallRecord[] = [];

  /** Add one response's usage; returns it in this harness's shape. */
  record(model: string, raw: Anthropic.Beta.BetaUsage): Usage {
    const usage: Usage = {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
    };
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens;
    this.usage.cacheWriteTokens += usage.cacheWriteTokens;
    this.costUsd += estimateCostUsd(model, usage);
    return usage;
  }

  get overBudget(): boolean {
    return GUARDRAILS.maxCostUsd !== undefined && this.costUsd > GUARDRAILS.maxCostUsd;
  }
}
`;
}

export function validateTs(): string {
  return `/**
 * Minimal JSON Schema check for tool inputs. Tools stream their input eagerly
 * (eager_input_streaming), so the API does not validate it: we do, before
 * running anything.
 */
interface Schema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[] | null;
  items?: Schema;
}

/** Returns a description of the first problem, or null when the input is valid. */
export function validateInput(schema: object, input: unknown): string | null {
  return check(schema as Schema, input, "input");
}

function check(schema: Schema, value: unknown, where: string): string | null {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    return \`\${where} should be \${types.join(" | ")}, got \${describe(value)}\`;
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    return \`\${where} should be one of \${JSON.stringify(schema.enum)}\`;
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return \`\${where}.\${key} is required\`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      const problem = check(sub, value[key], \`\${where}.\${key}\`);
      if (problem) return problem;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = check(schema.items, value[i], \`\${where}[\${i}]\`);
      if (problem) return problem;
    }
  }
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
`;
}

export function clientTs(): string {
  return `import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

/**
 * The shared Anthropic client, created on first use so modules that only run
 * tools never need credentials. Reads ANTHROPIC_API_KEY from the environment.
 */
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** A one-line, human-readable description of an error (no stack traces for API failures). */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "Interrupted.";
  if (err instanceof Anthropic.AuthenticationError) {
    return "Authentication failed: set a valid ANTHROPIC_API_KEY (in .env or your shell).";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return \`Permission denied by the Anthropic API: \${err.message}\`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API; wait a moment and retry.";
  if (err instanceof Anthropic.APIConnectionError) return \`Could not reach the Anthropic API: \${err.message}\`;
  if (err instanceof Anthropic.APIError) return \`Anthropic API error (\${err.status ?? "no status"}): \${err.message}\`;
  if (err instanceof Anthropic.AnthropicError && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return "ANTHROPIC_API_KEY is not set. Put it in .env next to package.json or export it in your shell.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
`;
}
