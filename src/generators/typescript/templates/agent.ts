import type { TsModel, TsSubagent } from "../model.js";
import { indent, str, tsLiteral } from "../render.js";

export function agentTs(m: TsModel): string {
  const hasSubagents = m.subagents.length > 0;
  return `/** The main agent: the system prompt, the full tool registry and the loop. */
import type Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./config.js";
import { runLoop } from "./loop.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { Session, type ToolCallRecord, type Usage } from "./session.js";
${hasSubagents ? `import { SUBAGENT_TOOLS } from "./subagents.js";\n` : ""}import { TOOLS } from "./tools/index.js";
import type { AgentEvent, Approver, ToolEntry } from "./types.js";

/** Every tool the main agent can call, in a stable order (it is part of the cached prefix). */
export const MAIN_TOOLS: ToolEntry[] = ${hasSubagents ? "[...TOOLS, ...SUBAGENT_TOOLS]" : "TOOLS"};

export interface RunAgentOptions {
  prompt: string;
  /** Earlier turns (the \`messages\` of a previous result) to continue a conversation. */
  history?: Anthropic.Beta.BetaMessageParam[];
  /** Called before any tool that needs approval (see GUARDRAILS.approvalMode). Defaults to deny. */
  approve?: Approver;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Overrides MODEL.id for this run. */
  model?: string;
}

export interface RunAgentResult {
  finalText: string;
  turns: number;
  stopReason: string | null;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Every tool call of the run, subagents included. */
  toolCalls: ToolCallRecord[];
  usage: Usage;
  costUsd: number;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const session = new Session();
  const result = await runLoop({
    model: opts.model ?? MODEL.id,
    effort: MODEL.effort,
    system: SYSTEM_PROMPT,
    tools: MAIN_TOOLS,
    messages: [...(opts.history ?? []), { role: "user", content: opts.prompt }],
    session,
    approve: serialize(opts.approve ?? (async () => false)),
    onEvent: opts.onEvent,
    signal: opts.signal,
  });
  return { ...result, toolCalls: session.toolCalls, usage: session.usage, costUsd: session.costUsd };
}

/** Subagents can run concurrently; make sure the human sees one approval prompt at a time. */
function serialize(approve: Approver): Approver {
  let queue: Promise<unknown> = Promise.resolve();
  return (call) => {
    const answer = queue.then(() => approve(call));
    queue = answer.catch(() => undefined);
    return answer;
  };
}
`;
}

export function subagentsTs(m: TsModel): string {
  const configs = m.subagents.map((s) => indent(subagentLiteral(s), 2)).join("\n");
  return `/**
 * Subagents, generated from decree.json. Each one is exposed to the main agent
 * as a delegate_to_* tool that runs a nested loop with its own system prompt,
 * model and tool subset, and returns the subagent's final answer.
 */
import type { Effort } from "./config.js";
import { runLoop } from "./loop.js";
import { TOOLS } from "./tools/index.js";
import type { ToolEntry } from "./types.js";

interface Subagent {
  name: string;
  toolName: string;
  description: string;
  systemPrompt: string;
  /** Names of entries in TOOLS this subagent may use. */
  tools: string[];
  model: string;
  effort: Effort;
}

const SUBAGENTS: Subagent[] = [
${configs}
];

export const SUBAGENT_TOOLS: ToolEntry[] = SUBAGENTS.map(delegateTool);

function delegateTool(subagent: Subagent): ToolEntry {
  const tools = TOOLS.filter((t) => subagent.tools.includes(t.definition.name));
  return {
    definition: {
      name: subagent.toolName,
      description: subagent.description,
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task for the subagent, with all the context it needs: it cannot see this conversation.",
          },
        },
        required: ["task"],
      },
      eager_input_streaming: true,
    },
    // Safety follows the tools the subagent can reach; their own approvals still apply inside.
    readOnly: tools.every((t) => t.readOnly),
    destructive: tools.some((t) => t.destructive),
    requiresApproval: false,
    run: async (input, ctx) => {
      const result = await runLoop({
        agent: subagent.name,
        model: subagent.model,
        effort: subagent.effort,
        system: subagent.systemPrompt,
        tools,
        messages: [{ role: "user", content: String(input.task) }],
        session: ctx.session,
        approve: ctx.approve,
        // Show the subagent's tool activity, not its streamed text: its answer comes back as the result.
        onEvent: (event) => {
          if (event.type !== "text" && event.type !== "thinking") ctx.onEvent?.(event);
        },
        signal: ctx.signal,
      });
      const finished = result.stopReason === "end_turn";
      const output = result.finalText || \`The \${subagent.name} subagent stopped without an answer (\${result.stopReason}).\`;
      return { output: finished ? output : \`\${output}\\n\\n[subagent stopped: \${result.stopReason}]\`, isError: !finished && !result.finalText };
    },
  };
}
`;
}

function subagentLiteral(s: TsSubagent): string {
  const lines = [
    "{",
    `  name: ${str(s.name)},`,
    `  toolName: ${str(s.toolName)},`,
    `  description: ${str(s.description)},`,
    `  systemPrompt: ${str(s.systemPrompt)},`,
    `  tools: ${tsLiteral(s.tools, 1)},`,
    `  model: ${str(s.model)},`,
    `  effort: ${str(s.effort)},`,
    "},",
  ];
  return lines.join("\n");
}
