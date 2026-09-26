import Anthropic from "@anthropic-ai/sdk";
import type { HarnessSpec, RunOptions, RunResult, RuntimeEvent } from "../core/types.js";
import { MissingApiKeyError, resolveApiKey } from "../llm/client.js";
import { agentLoop, zeroUsage, type Budget, type MessageLike, type MessagesClientLike, type ModelResponse } from "./loop.js";
import { redact, type ToolContext } from "./tools/index.js";
import { Transcript } from "./transcript.js";

export { executeTool, buildToolParams, needsApproval, delegateToolName, DECLINED_MESSAGE } from "./tools/index.js";
export type { ToolContext, ToolOutput } from "./tools/index.js";
export { buildRequest, agentLoop } from "./loop.js";
export type { MessagesClientLike, StreamLike, ModelResponse, RuntimeErrorEvent } from "./loop.js";

/** Create the Anthropic client for a run, or throw MissingApiKeyError. */
export function createRuntimeClient(apiKey?: string): Anthropic {
  const key = apiKey ?? resolveApiKey();
  if (!key) throw new MissingApiKeyError();
  // authToken: null so a stray ANTHROPIC_AUTH_TOKEN in the environment doesn't add a second
  // (conflicting) Authorization header next to x-api-key; matches createLLM.
  return new Anthropic({ apiKey: key, authToken: null });
}

/** Run the harness described by `spec` live against Claude, executing tools locally. */
export async function runAgent(spec: HarnessSpec, opts: RunOptions): Promise<RunResult> {
  return runAgentWithClient(spec, opts, createRuntimeClient(opts.apiKey));
}

function compactContent(content: ModelResponse["content"]): unknown[] {
  // Keep transcripts readable: drop opaque thinking signatures / encrypted blobs.
  return content.map((b) => {
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
    if (b.type === "redacted_thinking") return { type: "redacted_thinking" };
    return b;
  });
}

/** Same as runAgent, with an injected client (the real SDK client, or a test double). */
export async function runAgentWithClient(
  spec: HarnessSpec,
  opts: RunOptions,
  client: MessagesClientLike | Anthropic,
): Promise<RunResult> {
  const env = process.env;
  const scrubNames = Array.from(new Set([...(spec.guardrails.redactEnv ?? []), "ANTHROPIC_API_KEY"]));
  const scrub = (line: string): string => {
    let out = redact(line, scrubNames, env);
    if (opts.apiKey && opts.apiKey.length >= 4) out = out.split(opts.apiKey).join("[REDACTED:API_KEY]");
    return out;
  };
  const transcript = new Transcript(opts.projectRoot, scrub);

  const emit = (e: RuntimeEvent): void => {
    if (e.type !== "text" && e.type !== "thinking") transcript.write({ event: e });
    try {
      opts.onEvent?.(e);
    } catch {
      /* a UI callback must not break the loop */
    }
  };

  const model = opts.model ?? spec.model.id;
  const messages: MessageLike[] = [...((opts.history ?? []) as MessageLike[]), { role: "user", content: opts.prompt }];
  const budget: Budget = { usage: zeroUsage(), costUsd: 0, maxCostUsd: spec.guardrails.maxCostUsd };
  const toolCalls: RunResult["toolCalls"] = [];
  const ctx: ToolContext = { projectRoot: opts.projectRoot, spec, dryRun: opts.dryRun, signal: opts.signal };

  transcript.write({
    event: { type: "start" },
    harness: spec.name,
    model,
    prompt: opts.prompt,
    dryRun: !!opts.dryRun,
    historyMessages: opts.history?.length ?? 0,
  });

  let result;
  try {
    result = await agentLoop({
      client: client as MessagesClientLike,
      spec,
      agentName: "main",
      model,
      effort: spec.model.effort,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      subagents: spec.subagents,
      messages,
      maxTurns: spec.guardrails.maxTurns,
      ctx,
      approve: opts.approve,
      emit,
      streamDeltas: true,
      budget,
      signal: opts.signal,
      toolCalls,
      onResponse: ({ agent, turn, response }) =>
        transcript.write({
          event: { type: "assistant" },
          agent,
          turn,
          stopReason: response.stop_reason,
          content: compactContent(response.content),
        }),
    });
  } catch (err) {
    emit({ type: "error", message: `Model request failed: ${(err as Error).message}` });
    throw err;
  }

  emit({ type: "done", finalText: result.finalText, turns: result.turns, usage: { ...budget.usage }, costUsd: budget.costUsd });
  return {
    finalText: result.finalText,
    turns: result.turns,
    toolCalls,
    usage: { ...budget.usage },
    costUsd: budget.costUsd,
    messages,
    stopReason: result.stopReason,
  };
}
