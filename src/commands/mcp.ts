import type { Command } from "commander";
import { serveMcp } from "../mcp/server.js";
import { rootFor } from "./context.js";

/**
 * `decree-harness mcp`: serve get_decisions over stdio for Claude Code, Cursor or any MCP client, reading
 * decree.json in the project root. Nothing to generate or build first.
 */
export async function mcpCommand(_opts: unknown, cmd: Command): Promise<void> {
  const root = rootFor(cmd);
  process.stderr.write(`decree MCP server: serving decisions from ${root}\n`);
  await serveMcp({ root });
}
