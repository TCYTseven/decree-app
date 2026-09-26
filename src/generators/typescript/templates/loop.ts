/** The agent loop of the generated project (static: behavior is driven by config.ts). */
export function loopTs(): string {
  return `/**
 * The agent loop: stream a turn from Claude, run the tools it asked for, feed
 * the results back, repeat. Shared by the main agent and every subagent.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./client.js";
import { CONTEXT, GUARDRAILS, MODEL, type Effort } from "./config.js";
import type { Session } from "./session.js";
import type { AgentEvent, Approver, ToolContext, ToolEntry, ToolResult } from "./types.js";
import { validateInput } from "./validate.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

export interface LoopOptions {
  /** Set for subagents; tags their events. */
  agent?: string;
  model: string;
  effort: Effort;
  system: string;
  tools: ToolEntry[];
  /** Conversation so far, ending with the user's message. Not mutated. */
  messages: MessageParam[];
  session: Session;
  approve: Approver;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface LoopResult {
  finalText: string;
  turns: number;
  /** The API stop_reason of the last turn, or "max_turns" / "max_cost". */
  stopReason: string | null;
  /** The full transcript, for continuing the conversation. */
  messages: MessageParam[];
}

const DECLINED = "The user declined this action. Ask them how to proceed.";
/** Retries when a streamed tool input is not parseable JSON (eager input streaming). */
const MAX_INPUT_RETRIES = 2;

/** Beta headers and context-management edits, from CONTEXT in config.ts. */
const BETAS: Anthropic.Beta.AnthropicBeta[] = [];
const EDITS: NonNullable<Anthropic.Beta.BetaContextManagementConfig["edits"]> = [];
if (CONTEXT.contextEditing) {
  BETAS.push("context-management-2025-06-27");
  EDITS.push({ type: "clear_tool_uses_20250919" });
}
if (CONTEXT.compaction) {
  BETAS.push("compact-2026-01-12");
  EDITS.push({ type: "compact_20260112" });
}

export function needsApproval(tool: ToolEntry): boolean {
  switch (GUARDRAILS.approvalMode) {
    case "never":
      return false;
    case "always":
      return !tool.readOnly || tool.requiresApproval;
    case "destructive":
      return tool.requiresApproval || tool.destructive;
  }
}

/** Replace the value of every env var in GUARDRAILS.redactEnv with [REDACTED:<NAME>]. */
export function redact(text: string): string {
  let out = text;
  for (const name of GUARDRAILS.redactEnv) {
    const value = process.env[name];
    if (value && value.length >= 4) out = out.split(value).join(\`[REDACTED:\${name}]\`);
  }
  return out;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const messages = [...opts.messages];
  const tools = new Map(opts.tools.map((t) => [t.definition.name, t]));
  const emit = (event: AgentEvent) => opts.onEvent?.(opts.agent ? { ...event, agent: opts.agent } : event);
  let finalText = "";
  let stopReason: string | null = null;
  let turns = 0;

  while (true) {
    if (turns >= GUARDRAILS.maxTurns) {
      stopReason = "max_turns";
      emit({ type: "notice", message: \`Stopped after \${GUARDRAILS.maxTurns} turns (GUARDRAILS.maxTurns).\` });
      break;
    }
    if (opts.session.overBudget) {
      stopReason = "max_cost";
      emit({ type: "notice", message: \`Stopped: estimated cost $\${opts.session.costUsd.toFixed(2)} passed GUARDRAILS.maxCostUsd.\` });
      break;
    }
    turns++;

    const message = await streamTurn(opts, messages, emit);
    const usage = opts.session.record(message.model, message.usage);
    stopReason = message.stop_reason;
    emit({ type: "turn_end", turn: turns, stopReason, usage });
    finalText = textOf(message.content) || finalText;
    recordServerToolCalls(message.content, opts.session, opts.agent, emit);

    const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (message.stop_reason === "refusal") {
      // A refusal can cut a tool call off mid-input: never run it or keep it in history.
      const details = message.stop_details;
      const reason = details?.explanation ?? details?.category ?? "no details";
      emit({ type: "notice", message: \`Claude declined to continue (\${reason}).\` });
      break;
    }
    if (message.stop_reason === "max_tokens") {
      // Tool input may be truncated, so do not run it; keep a plain-text answer.
      if (toolUses.length === 0) messages.push({ role: "assistant", content: message.content });
      emit({ type: "notice", message: "Stopped: the response hit max_tokens (GUARDRAILS.maxOutputTokensPerTurn)." });
      break;
    }

    // Always keep the full content: thinking, compaction and server-tool blocks must round-trip.
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn" || message.stop_reason === "compaction") {
      continue; // the server paused mid-turn; resending the conversation resumes it
    }
    if (message.stop_reason === "model_context_window_exceeded") {
      emit({ type: "notice", message: "Stopped: the context window is full (enable CONTEXT.compaction, or start over)." });
    }
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const results = await runTools(toolUses, tools, opts, emit);
    messages.push({ role: "user", content: results });
  }

  return { finalText, turns, stopReason, messages };
}

/** Stream one model turn, forwarding text as it arrives. */
async function streamTurn(opts: LoopOptions, messages: MessageParam[], emit: (e: AgentEvent) => void) {
  for (let attempt = 0; ; attempt++) {
    const stream = anthropic().beta.messages.stream(
      {
        model: opts.model,
        max_tokens: GUARDRAILS.maxOutputTokensPerTurn,
        system: [
          {
            type: "text",
            text: opts.system,
            // Breakpoint on the static prefix (tools + system prompt).
            ...(CONTEXT.caching ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ],
        messages,
        tools: opts.tools.map((t) => t.definition),
        output_config: { effort: opts.effort },
        ...(MODEL.thinking === "adaptive" ? { thinking: { type: "adaptive" as const } } : {}),
        // Automatic caching of the growing conversation tail.
        ...(CONTEXT.caching ? { cache_control: { type: "ephemeral" as const } } : {}),
        ...(EDITS.length > 0 ? { context_management: { edits: EDITS } } : {}),
        ...(BETAS.length > 0 ? { betas: BETAS } : {}),
      },
      { signal: opts.signal },
    );
    stream.on("text", (text) => emit({ type: "text", text }));
    stream.on("thinking", (text) => emit({ type: "thinking", text }));
    try {
      return await stream.finalMessage();
    } catch (err) {
      // API errors (auth, rate limit, abort, ...) and failures before any response
      // (e.g. no credentials) propagate. A failure after the response arrived means
      // a streamed tool input could not be parsed: re-issue the turn a couple of times.
      const malformed = !(err instanceof Anthropic.APIError) && stream.response != null;
      if (!malformed || attempt >= MAX_INPUT_RETRIES) throw err;
      emit({ type: "notice", message: "A tool input was not valid JSON; retrying the turn." });
    }
  }
}

/**
 * Run every tool call of one turn and return all results, in call order, for a
 * single user message. Approvals are asked first, one at a time; then
 * consecutive read-only calls run concurrently and the rest run sequentially.
 */
async function runTools(
  calls: ToolUseBlock[],
  tools: Map<string, ToolEntry>,
  opts: LoopOptions,
  emit: (e: AgentEvent) => void,
): Promise<ToolResultBlock[]> {
  const ctx: ToolContext = { session: opts.session, approve: opts.approve, onEvent: opts.onEvent, signal: opts.signal };
  const planned: { call: ToolUseBlock; tool?: ToolEntry; blocked?: ToolResult }[] = [];

  for (const call of calls) {
    emit({ type: "tool_call", id: call.id, name: call.name, input: call.input });
    const tool = tools.get(call.name);
    if (!tool?.run) {
      planned.push({ call, blocked: { output: \`Unknown tool: \${call.name}\`, isError: true } });
      continue;
    }
    const schema = "input_schema" in tool.definition ? tool.definition.input_schema : undefined;
    const problem = schema ? validateInput(schema, call.input) : null;
    if (problem) {
      const output = JSON.stringify({ INVALID_INPUT: problem, received: JSON.stringify(call.input) });
      planned.push({ call, blocked: { output, isError: true } });
      continue;
    }
    if (needsApproval(tool) && !(await opts.approve({ name: call.name, input: call.input, tool }))) {
      emit({ type: "approval_denied", id: call.id, name: call.name });
      planned.push({ call, blocked: { output: DECLINED, isError: true } });
      continue;
    }
    planned.push({ call, tool });
  }

  const execute = async ({ call, tool, blocked }: (typeof planned)[number]): Promise<ToolResultBlock> => {
    const started = Date.now();
    let result = blocked;
    if (!result) {
      try {
        result = await tool!.run!(call.input as Record<string, unknown>, ctx);
      } catch (err) {
        result = { output: \`Tool failed: \${err instanceof Error ? err.message : String(err)}\`, isError: true };
      }
    }
    const output = redact(result.output) || "(no output)";
    emit({ type: "tool_result", id: call.id, name: call.name, output, isError: result.isError, ms: Date.now() - started });
    opts.session.toolCalls.push({ name: call.name, input: call.input, output, isError: result.isError, agent: opts.agent });
    return { type: "tool_result", tool_use_id: call.id, content: output, ...(result.isError ? { is_error: true } : {}) };
  };

  const results: ToolResultBlock[] = [];
  for (let i = 0; i < planned.length; ) {
    if (planned[i].tool?.readOnly || planned[i].blocked) {
      let j = i;
      while (j < planned.length && (planned[j].tool?.readOnly || planned[j].blocked)) j++;
      results.push(...(await Promise.all(planned.slice(i, j).map(execute))));
      i = j;
    } else {
      results.push(await execute(planned[i]));
      i++;
    }
  }
  return results;
}

/** Server tools (web search/fetch) run on Anthropic's side; record them for evals and display. */
function recordServerToolCalls(
  content: Anthropic.Beta.BetaContentBlock[],
  session: Session,
  agent: string | undefined,
  emit: (e: AgentEvent) => void,
): void {
  for (const block of content) {
    if (block.type !== "server_tool_use") continue;
    emit({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    session.toolCalls.push({ name: block.name, input: block.input, output: "(run by Anthropic)", isError: false, agent });
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
`;
}
