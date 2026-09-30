/**
 * A dependency-free MCP server (stdio, newline-delimited JSON-RPC 2.0) that serves `get_decisions` straight from
 * decree.json. It re-reads the file on every call, so `decisions confirm` / `supersede` take effect without a restart.
 * stdout carries protocol messages only; anything for a human goes to stderr.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { loadSpec, specExists } from "../core/config.js";
import { DECISIONS_INPUT_SCHEMA, DECISIONS_TOOL_DESCRIPTION, DECISIONS_TOOL_NAME } from "../decisions/tool.js";
import { runGetDecisions } from "../decisions/scope.js";
import { DECREE_VERSION, SPEC_FILENAME } from "../version.js";

/** Newest first. The server echoes the client's version when it knows it, and offers the newest otherwise. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;

interface Request {
  jsonrpc?: string;
  id?: Id;
  method?: unknown;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface McpServerOptions {
  root: string;
  input?: Readable;
  output?: Writable;
}

async function callGetDecisions(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!(await specExists(root))) {
    return {
      content: [{ type: "text", text: `No ${SPEC_FILENAME} in ${root}. Run \`npx decree-harness init\` there to extract the team's decisions.` }],
      isError: true,
    };
  }
  let decisions;
  try {
    decisions = (await loadSpec(root)).spec.decisions ?? [];
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }], isError: true };
  }
  const { output, isError } = runGetDecisions(decisions, args, root);
  return { content: [{ type: "text", text: output }], ...(isError ? { isError: true } : {}) };
}

/** Handle one request. Returns the `result` to send, or throws RpcError. */
export async function handleRequest(root: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "decree", version: DECREE_VERSION },
        instructions: `Call ${DECISIONS_TOOL_NAME} with the files you are about to change before you edit them, and follow the live team decisions it returns.`,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: DECISIONS_TOOL_NAME,
            description: DECISIONS_TOOL_DESCRIPTION,
            inputSchema: DECISIONS_INPUT_SCHEMA,
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
        ],
      };
    case "tools/call": {
      const name = params.name;
      if (name !== DECISIONS_TOOL_NAME) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      return callGetDecisions(root, args);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Serve MCP over the given streams (stdin/stdout by default) until the input closes. */
export function serveMcp(opts: McpServerOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const send = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  const pending = new Set<Promise<void>>();

  const onLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    const isNotification = !("id" in req);
    if (typeof req.method !== "string") {
      // A response to something we never sent, or garbage: nothing to answer.
      if (!isNotification && !("result" in req) && !("error" in req)) send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    if (isNotification) return; // notifications/initialized, notifications/cancelled, ...
    try {
      const result = await handleRequest(opts.root, req.method, req.params ?? {});
      send({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      send({ jsonrpc: "2.0", id: req.id, error: { code, message: (err as Error).message } });
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const p = onLine(line).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on("close", () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}
