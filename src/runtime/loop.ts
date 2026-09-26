import { AnthropicError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  Effort,
  HarnessSpec,
  LLMUsage,
  RunOptions,
  RunResult,
  RuntimeEvent,
  SubagentSpec,
  ToolSpec,
} from "../core/types.js";
import { estimateCostUsd } from "../llm/pricing.js";
import {
  buildToolParams,
  DECLINED_MESSAGE,
  delegateToolName,
  executeTool,
  fail,
  isServerTool,
  needsApproval,
  redact,
  validateInput,
  type ToolContext,
  type ToolOutput,
} from "./tools/index.js";

// ---------------------------------------------------------------------------
// Minimal client surface (the real Anthropic client satisfies it; tests inject fakes)
// ---------------------------------------------------------------------------

export interface StreamLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  finalMessage(): Promise<unknown>;
}

export interface MessagesClientLike {
  messages: { stream(body: any, options?: any): StreamLike };
  beta?: { messages: { stream(body: any, options?: any): StreamLike } };
}

export interface ContentBlockLike {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface ModelResponse {
  content: ContentBlockLike[];
  stop_reason: string | null;
  stop_details?: unknown;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface MessageLike {
  role: "user" | "assistant";
  content: string | unknown[];
}

/** Error event with the refusal's structured stop_details attached (extra field). */
export type RuntimeErrorEvent = Extract<RuntimeEvent, { type: "error" }> & { stopDetails?: unknown };

export const zeroUsage = (): LLMUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(into: LLMUsage, u: LLMUsage): void {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadTokens += u.cacheReadTokens;
  into.cacheWriteTokens += u.cacheWriteTokens;
}

export function toUsage(u: ModelResponse["usage"]): LLMUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function safeCost(model: string, usage: LLMUsage): number {
  try {
    const c = estimateCostUsd(model, usage);
    return Number.isFinite(c) ? c : 0;
  } catch {
    return 0;
  }
}

/** Shared spend tracker across the main agent and its subagents. */
export interface Budget {
  usage: LLMUsage;
  costUsd: number;
  maxCostUsd?: number;
}

export interface LoopConfig {
  client: MessagesClientLike;
  spec: HarnessSpec;
  agentName: string; // "main" or the subagent name
  model: string;
  effort: Effort;
  systemPrompt: string;
  tools: ToolSpec[];
  subagents: SubagentSpec[];
  messages: MessageLike[]; // mutated in place
  maxTurns: number;
  ctx: ToolContext;
  approve?: RunOptions["approve"];
  /** Receives every event this loop produces (text/thinking deltas only when streamDeltas). */
  emit: (e: RuntimeEvent) => void;
  streamDeltas: boolean;
  budget: Budget;
  signal?: AbortSignal;
  toolCalls: RunResult["toolCalls"]; // flattened across subagents
  onResponse?: (info: { agent: string; turn: number; response: ModelResponse }) => void;
}

export interface LoopResult {
  finalText: string;
  turns: number;
  stopReason: string | null;
  failed: boolean; // refusal / abort / limit / truncated tool call
}

const BETA_CONTEXT_EDITING = "context-management-2025-06-27";
const BETA_COMPACTION = "compact-2026-01-12";

export function buildRequest(cfg: Pick<LoopConfig, "spec" | "model" | "effort" | "systemPrompt" | "tools" | "subagents" | "messages">): {
  body: Record<string, unknown>;
  beta: boolean;
} {
  const { spec } = cfg;
  const caching = spec.context.caching;
  const system = [{ type: "text", text: cfg.systemPrompt, ...(caching ? { cache_control: { type: "ephemeral" } } : {}) }];
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: spec.guardrails.maxOutputTokensPerTurn,
    system,
    messages: [...cfg.messages],
    output_config: { effort: cfg.effort },
  };
  const tools = buildToolParams(spec, cfg.tools, cfg.subagents);
  if (tools.length) body.tools = tools;
  if (spec.model.thinking === "adaptive") body.thinking = { type: "adaptive", display: "summarized" };
  if (caching) body.cache_control = { type: "ephemeral" };
  const betas: string[] = [];
  const edits: Record<string, unknown>[] = [];
  if (spec.context.contextEditing) {
    betas.push(BETA_CONTEXT_EDITING);
    edits.push({ type: "clear_tool_uses_20250919" });
  }
  if (spec.context.compaction) {
    betas.push(BETA_COMPACTION);
    edits.push({ type: "compact_20260112" });
  }
  if (betas.length) {
    body.betas = betas;
    body.context_management = { edits };
  }
  return { body, beta: betas.length > 0 };
}

/** Client/server tool calls and server tool results: these must stay paired in history. */
function isToolBlock(b: ContentBlockLike): boolean {
  return b.type === "tool_use" || b.type === "server_tool_use" || b.type.endsWith("_tool_result");
}

function textOf(content: ContentBlockLike[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || err instanceof APIUserAbortError || (err as Error)?.name === "AbortError";
}

async function streamOnce(cfg: LoopConfig, body: Record<string, unknown>, beta: boolean): Promise<ModelResponse> {
  const api = beta ? cfg.client.beta?.messages : cfg.client.messages;
  if (!api) throw new Error("client does not support the beta messages API required by context.compaction/contextEditing");
  const stream = api.stream(body, cfg.signal ? { signal: cfg.signal } : undefined);
  if (cfg.streamDeltas) {
    stream.on("text", (delta: string) => cfg.emit({ type: "text", text: delta }));
    stream.on("thinking", (delta: string) => cfg.emit({ type: "thinking", text: delta }));
  }
  const msg = (await stream.finalMessage()) as ModelResponse;
  if (!msg || !Array.isArray(msg.content)) throw new Error("model returned no content");
  return msg;
}

function stopError(cfg: LoopConfig, message: string, extra: Partial<RuntimeErrorEvent> = {}): void {
  const e: RuntimeErrorEvent = { type: "error", message, ...extra };
  cfg.emit(e);
}

/** Run one agent loop (main or subagent) until a terminal stop. Throws on API errors. */
export async function agentLoop(cfg: LoopConfig): Promise<LoopResult> {
  const { spec, messages, budget } = cfg;
  const byName = new Map(cfg.tools.map((t) => [t.name, t] as const));
  const subByTool = new Map(cfg.subagents.map((s) => [delegateToolName(s.name), s] as const));
  // The agent's own API key is always scrubbed: shell tools inherit it via process.env.
  const redactNames = [...new Set([...(spec.guardrails.redactEnv ?? []), "ANTHROPIC_API_KEY"])];
  const env = cfg.ctx.env ?? process.env;

  let turns = 0;
  let textSinceTools: string[] = [];
  let stopReason: string | null = null;
  let failed = false;
  let jsonRetries = 0;

  for (;;) {
    if (cfg.signal?.aborted) {
      stopReason = "aborted";
      failed = true;
      stopError(cfg, "Run aborted.");
      break;
    }
    if (turns >= cfg.maxTurns) {
      stopReason = "max_turns";
      failed = true;
      stopError(cfg, `Stopped: reached guardrails.maxTurns (${cfg.maxTurns}).`);
      break;
    }

    const { body, beta } = buildRequest(cfg);
    let response: ModelResponse;
    try {
      response = await streamOnce(cfg, body, beta);
    } catch (err) {
      if (isAbort(err, cfg.signal)) {
        stopReason = "aborted";
        failed = true;
        stopError(cfg, "Run aborted.");
        break;
      }
      // With eager input streaming the SDK rejects when a tool input is not parseable
      // JSON (an AnthropicError that is not an APIError). Re-issue the turn, capped.
      if (err instanceof AnthropicError && !(err instanceof APIError) && jsonRetries < 2) {
        jsonRetries++;
        continue;
      }
      throw err;
    }
    jsonRetries = 0;
    turns++;

    const usage = toUsage(response.usage);
    addUsage(budget.usage, usage);
    budget.costUsd += safeCost(cfg.model, usage);
    stopReason = response.stop_reason;
    cfg.onResponse?.({ agent: cfg.agentName, turn: turns, response });
    cfg.emit({ type: "turn_end", turn: turns, stopReason, usage });

    const content = response.content;
    const text = textOf(content);
    if (text) textSinceTools.push(text);

    // Server tools (web_search/web_fetch) ran on Anthropic's side; surface them.
    for (const b of content) {
      if (b.type === "server_tool_use" && b.id && b.name) {
        cfg.emit({ type: "tool_call", id: b.id, name: b.name, input: b.input });
        cfg.toolCalls.push({ name: b.name, input: b.input, output: "(executed by Anthropic)", isError: false });
      }
    }

    const toolUses = content.filter((b) => b.type === "tool_use");

    if (stopReason === "pause_turn") {
      messages.push({ role: "assistant", content });
      continue;
    }

    if (stopReason === "max_tokens" || stopReason === "refusal") {
      // Never run tool calls from a truncated/refused turn; keep the rest of the content.
      // Server tool results go too: without their server_tool_use they would be orphans
      // and the next request (chat keeps this history) would be rejected.
      const kept = content.filter((b) => !isToolBlock(b));
      if (kept.some((b) => b.type === "text" || b.type === "compaction")) messages.push({ role: "assistant", content: kept });
      failed = stopReason === "refusal" || toolUses.length > 0;
      if (stopReason === "refusal") {
        const details = response.stop_details ?? null;
        const d = (details ?? {}) as { category?: unknown; explanation?: unknown };
        stopError(
          cfg,
          `Model refused${d.category ? ` (category: ${String(d.category)})` : ""}${d.explanation ? `: ${String(d.explanation)}` : "."}`,
          { stopDetails: details },
        );
      } else if (toolUses.length) {
        stopError(cfg, `Response hit max_tokens (${spec.guardrails.maxOutputTokensPerTurn}); ${toolUses.length} truncated tool call(s) were not run.`);
      }
      break;
    }

    if (stopReason !== "tool_use" && toolUses.length > 0) {
      // Any other stop (e.g. model_context_window_exceeded) can leave tool calls we will
      // never answer; an unanswered tool_use would make the kept history invalid.
      const kept = content.filter((b) => !isToolBlock(b));
      if (kept.length) messages.push({ role: "assistant", content: kept });
      failed = true;
      stopError(cfg, `Stopped (${stopReason ?? "unknown stop reason"}); ${toolUses.length} tool call(s) were not run.`);
      break;
    }

    // An empty assistant message is rejected by the API once it is no longer the last turn.
    if (content.length > 0) messages.push({ role: "assistant", content });

    if (stopReason !== "tool_use" || toolUses.length === 0) break; // end_turn / stop_sequence / other terminal

    const results = await runToolCalls(cfg, toolUses, byName, subByTool, redactNames, env);
    messages.push({ role: "user", content: results });
    textSinceTools = [];

    if (budget.maxCostUsd !== undefined && budget.costUsd > budget.maxCostUsd) {
      stopReason = "max_cost";
      failed = true;
      stopError(cfg, `Stopped: estimated cost $${budget.costUsd.toFixed(4)} exceeded guardrails.maxCostUsd ($${budget.maxCostUsd}).`);
      break;
    }
  }

  return { finalText: textSinceTools.join("\n\n"), turns, stopReason, failed };
}

async function runToolCalls(
  cfg: LoopConfig,
  toolUses: ContentBlockLike[],
  byName: Map<string, ToolSpec>,
  subByTool: Map<string, SubagentSpec>,
  redactNames: string[],
  env: NodeJS.ProcessEnv,
): Promise<unknown[]> {
  const results: unknown[] = new Array(toolUses.length);
  const mode = cfg.spec.guardrails.approvalMode;

  const parallelizable = (b: ContentBlockLike): boolean => {
    const tool = b.name ? byName.get(b.name) : undefined;
    return !!tool && tool.readOnly && !isServerTool(tool) && !needsApproval(tool, mode);
  };

  const handle = async (b: ContentBlockLike, index: number): Promise<void> => {
    const id = b.id ?? `tool_${index}`;
    const name = b.name ?? "";
    const input = b.input;
    cfg.emit({ type: "tool_call", id, name, input });
    const started = Date.now();
    let out: ToolOutput;
    try {
      out = await runOne(cfg, id, name, input, byName, subByTool, mode);
    } catch (err) {
      out = fail(`Tool ${name} failed: ${(err as Error).message}`);
    }
    const output = redact(out.output, redactNames, env) || "(no output)";
    cfg.emit({ type: "tool_result", id, name, output, isError: out.isError, ms: Date.now() - started });
    cfg.toolCalls.push({ name, input, output, isError: out.isError });
    results[index] = { type: "tool_result", tool_use_id: id, content: output, ...(out.isError ? { is_error: true } : {}) };
  };

  let i = 0;
  while (i < toolUses.length) {
    if (parallelizable(toolUses[i])) {
      let j = i;
      while (j < toolUses.length && parallelizable(toolUses[j])) j++;
      const batch: Promise<void>[] = [];
      for (let k = i; k < j; k++) batch.push(handle(toolUses[k], k));
      await Promise.all(batch);
      i = j;
    } else {
      await handle(toolUses[i], i);
      i++;
    }
  }
  return results;
}

async function runOne(
  cfg: LoopConfig,
  id: string,
  name: string,
  input: unknown,
  byName: Map<string, ToolSpec>,
  subByTool: Map<string, SubagentSpec>,
  mode: HarnessSpec["guardrails"]["approvalMode"],
): Promise<ToolOutput> {
  if (cfg.signal?.aborted) return fail("Run aborted before this tool ran.");

  const sub = subByTool.get(name);
  if (sub) {
    const invalid = validateInput(
      { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      input,
    );
    if (invalid) return fail(invalid);
    return runSubagent(cfg, sub, String((input as { task: string }).task));
  }

  const tool = byName.get(name);
  if (!tool || isServerTool(tool)) return fail(`Unknown tool: ${name}`);

  const invalid =
    tool.kind === "memory"
      ? validateInput({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }, input)
      : validateInput(tool.inputSchema, input);
  if (invalid) return fail(invalid);

  if (needsApproval(tool, mode)) {
    let approved = false;
    if (cfg.approve) {
      try {
        approved = await cfg.approve({ name, input, tool });
      } catch {
        approved = false;
      }
    }
    if (!approved) {
      cfg.emit({ type: "approval_denied", id, name });
      return fail(DECLINED_MESSAGE);
    }
  }
  return executeTool(tool, input, cfg.ctx);
}

async function runSubagent(parent: LoopConfig, sub: SubagentSpec, task: string): Promise<ToolOutput> {
  const { spec } = parent;
  const allowed = new Set(sub.tools);
  const tools = spec.tools.filter((t) => allowed.has(t.name));
  const forward = (e: RuntimeEvent) => {
    if (e.type === "tool_call" || e.type === "tool_result" || e.type === "approval_denied") parent.emit(e);
    else if (e.type === "error") parent.emit({ ...e, message: `[${sub.name}] ${e.message}` });
  };
  try {
    const res = await agentLoop({
      ...parent,
      agentName: sub.name,
      model: sub.model ?? spec.model.subagentId,
      effort: sub.effort ?? "medium",
      systemPrompt: sub.systemPrompt,
      tools,
      subagents: [],
      messages: [{ role: "user", content: task }],
      maxTurns: spec.guardrails.maxTurns,
      emit: forward,
      streamDeltas: false,
    });
    const text = res.finalText || "(the subagent returned no text)";
    if (res.failed) return { output: `${text}\n[subagent stopped: ${res.stopReason}]`, isError: res.stopReason !== "max_turns" };
    return { output: text, isError: false };
  } catch (err) {
    if (isAbort(err, parent.signal)) return fail("Subagent aborted.");
    return fail(`Subagent ${sub.name} failed: ${(err as Error).message}`);
  }
}
