import type Anthropic from "@anthropic-ai/sdk";
import { stripPrivateKeywords } from "../../core/json-schema.js";
import type { Guardrails, HarnessSpec, SubagentSpec, ToolSpec } from "../../core/types.js";
import { envOf, fail, redact, validateInput, type ToolContext, type ToolInput, type ToolOutput } from "./common.js";
import { executeListFiles, executeReadFile, executeSearch, executeWriteFile } from "./fs.js";
import { executeHttp } from "./http.js";
import { executeMemory } from "./memory.js";
import { executeShell } from "./shell.js";
import { runGetDecisions } from "../../decisions/scope.js";

export * from "./common.js";
export { prepareHttpRequest, executeHttp } from "./http.js";
export { renderShellCommand, shellQuote, executeShell, runShell } from "./shell.js";
export { executeReadFile, executeWriteFile, executeListFiles, executeSearch } from "./fs.js";
export { executeMemory, resolveMemoryPath, memoryDirFor } from "./memory.js";

export const SERVER_TOOL_KINDS = new Set<ToolSpec["kind"]>(["web_search", "web_fetch"]);

export function isServerTool(tool: ToolSpec): boolean {
  return SERVER_TOOL_KINDS.has(tool.kind);
}

/** `delegate_to_<name with - replaced by _>` */
export function delegateToolName(subagentName: string): string {
  return `delegate_to_${subagentName.replace(/-/g, "_")}`;
}

/** Approval rule from ARCHITECTURE "Approval". */
export function needsApproval(tool: ToolSpec, mode: Guardrails["approvalMode"]): boolean {
  if (mode === "never") return false;
  if (mode === "always") return !tool.readOnly || tool.requiresApproval;
  return tool.requiresApproval || tool.destructive;
}

export const DECLINED_MESSAGE = "The user declined this action. Ask them how to proceed.";

/**
 * Anthropic tool definitions for `tools` (spec order, deterministic) followed by
 * one `delegate_to_*` tool per subagent. Server tools and memory are declared by type.
 */
export function buildToolParams(
  spec: HarnessSpec,
  tools: ToolSpec[] = spec.tools,
  subagents: SubagentSpec[] = spec.subagents,
): Anthropic.Messages.ToolUnion[] {
  const out: Anthropic.Messages.ToolUnion[] = [];
  for (const tool of tools) {
    switch (tool.kind) {
      case "web_search":
        out.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
        break;
      case "web_fetch":
        out.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 });
        break;
      case "memory":
        out.push({ type: "memory_20250818", name: "memory" });
        break;
      default: {
        // decree-private keywords (`x-allow-flags`, ...) stay local; the API never sees them.
        const schema = stripPrivateKeywords(tool.inputSchema ?? {});
        out.push({
          name: tool.name,
          description: tool.description,
          input_schema: {
            ...schema,
            type: "object",
            properties: schema.properties ?? {},
            ...(schema.required && schema.required.length ? { required: schema.required } : {}),
          } as Anthropic.Messages.Tool.InputSchema,
          // Streamed requests: let large inputs (file bodies) stream; we validate before running.
          eager_input_streaming: true,
        });
      }
    }
  }
  for (const sub of subagents) {
    out.push({
      name: delegateToolName(sub.name),
      description: sub.description,
      input_schema: {
        type: "object",
        properties: { task: { type: "string", description: "The complete task for the subagent, with all context it needs." } },
        required: ["task"],
      },
      eager_input_streaming: true,
    });
  }
  return out;
}

async function dispatch(tool: ToolSpec, input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
  switch (tool.kind) {
    case "http":
      return executeHttp(tool, input, ctx);
    case "shell":
      return executeShell(tool, input, ctx);
    case "read_file":
      return executeReadFile(tool, input, ctx);
    case "write_file":
      return executeWriteFile(tool, input, ctx);
    case "list_files":
      return executeListFiles(tool, input, ctx);
    case "search":
      return executeSearch(tool, input, ctx);
    case "memory":
      return executeMemory(input, ctx);
    case "decisions":
      return runGetDecisions(ctx.spec.decisions ?? [], input, ctx.projectRoot);
    case "web_search":
    case "web_fetch":
      return fail(`${tool.name} is an Anthropic server tool; it is executed by the API, not locally.`);
    default:
      return fail(`Unsupported tool kind: ${String((tool as ToolSpec).kind)}`);
  }
}

/**
 * Validate and execute one client-side tool call. Never throws: failures come back
 * as `{ isError: true }`. Output is redacted per `guardrails.redactEnv`.
 */
export async function executeTool(tool: ToolSpec, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  let result: ToolOutput;
  const invalid =
    tool.kind === "memory"
      ? validateInput({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }, input)
      : isServerTool(tool)
        ? undefined
        : validateInput(tool.inputSchema, input);
  if (invalid) {
    result = fail(invalid);
  } else {
    try {
      result = await dispatch(tool, (input ?? {}) as ToolInput, ctx);
    } catch (err) {
      result = fail(`Tool ${tool.name} failed: ${(err as Error).message}`);
    }
  }
  return { output: redact(result.output, ctx.spec.guardrails.redactEnv ?? [], envOf(ctx)), isError: result.isError };
}
