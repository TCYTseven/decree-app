import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/core/types.js";
import { serializeSpec } from "../src/core/config.js";
import { runCli } from "../src/commands/program.js";
import { MCP_PROTOCOL_VERSIONS, serveMcp } from "../src/mcp/server.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const DECISIONS: Decision[] = [
  { id: "adr-0003-use-postgres", title: "Use Postgres", constraint: "Store orders in Postgres.", status: "live", governs: ["src/db/**"], source: "docs/adr/0003.md" },
  { id: "rule-no-raw-sql", title: "No raw SQL", constraint: "Never write raw SQL in handlers.", status: "proposed", governs: ["src/**"], source: "CLAUDE.md:4" },
  { id: "adr-0001-use-mongo", title: "Use Mongo", constraint: "Store orders in Mongo.", status: "superseded", governs: ["src/db/**"], source: "docs/adr/0001.md", supersededBy: "adr-0003-use-postgres" },
];

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-mcp-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const writeSpec = (decisions: Decision[]) => fs.writeFile(path.join(root, "decree.json"), serializeSpec(sampleSpec({ decisions })));

/** Send newline-delimited messages to an in-process server and collect every response line. */
async function exchange(messages: (object | string)[]): Promise<{ id?: unknown; result?: any; error?: { code: number; message: string } }[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => (raw += String(chunk)));
  const done = serveMcp({ root, input, output });
  for (const m of messages) input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  input.end();
  await done;
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const call = (id: number, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_decisions", arguments: args } });

describe("decree-harness mcp", () => {
  it("initializes, lists get_decisions and ignores notifications", async () => {
    const res = await exchange([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    expect(res).toHaveLength(3);
    expect(res[0]!.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "decree" } });
    expect(res[1]!.result.tools.map((t: { name: string }) => t.name)).toEqual(["get_decisions"]);
    expect(res[1]!.result.tools[0].inputSchema.required).toEqual(["paths"]);
    expect(res[2]).toMatchObject({ id: 3, result: {} });
  });

  it("offers its newest protocol version to a client it does not know", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }]);
    expect(res!.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it("serves live decisions for a path and hides proposed and superseded ones", async () => {
    await writeSpec(DECISIONS);
    const [res] = await exchange([call(1, { paths: ["src/db/users.ts"] })]);
    const text = res!.result.content[0].text as string;
    expect(res!.result.isError).toBeUndefined();
    expect(text).toContain("[adr-0003-use-postgres] Use Postgres");
    expect(text).not.toContain("rule-no-raw-sql");
    expect(text).not.toContain("adr-0001-use-mongo");
  });

  it("include_proposed adds proposed decisions; absolute paths inside the repo are made relative", async () => {
    await writeSpec(DECISIONS);
    const [res] = await exchange([call(1, { paths: [path.join(root, "src/db/users.ts")], include_proposed: true })]);
    const text = res!.result.content[0].text as string;
    expect(text).toContain("adr-0003-use-postgres");
    expect(text).toContain("rule-no-raw-sql");
  });

  it("re-reads decree.json on every call", async () => {
    await writeSpec(DECISIONS);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
    const done = serveMcp({ root, input, output });
    const next = () => new Promise<any>((resolve) => output.once("data", (chunk) => resolve(JSON.parse(String(chunk)))));

    let reply = next();
    input.write(`${JSON.stringify(call(1, { paths: ["src/api/orders.ts"] }))}\n`);
    expect((await reply).result.content[0].text).toContain("No live decisions");

    await writeSpec(DECISIONS.map((d) => (d.id === "rule-no-raw-sql" ? { ...d, status: "live" as const } : d)));
    reply = next();
    input.write(`${JSON.stringify(call(2, { paths: ["src/api/orders.ts"] }))}\n`);
    expect((await reply).result.content[0].text).toContain("rule-no-raw-sql");
    input.end();
    await done;
  });

  it("reports a missing decree.json and bad arguments as tool errors, not protocol errors", async () => {
    let [res] = await exchange([call(1, { paths: ["src"] })]);
    expect(res!.result.isError).toBe(true);
    expect(res!.result.content[0].text).toContain("No decree.json");
    await writeSpec(DECISIONS);
    [res] = await exchange([call(2, { paths: [] })]);
    expect(res!.result.isError).toBe(true);
    expect(res!.result.content[0].text).toContain('Pass "paths"');
  });

  it("answers unknown methods, unknown tools and malformed JSON with JSON-RPC errors", async () => {
    const res = await exchange([
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
      "{not json",
    ]);
    expect(res.find((r) => r.id === 1)!.error!.code).toBe(-32601);
    expect(res.find((r) => r.id === 2)!.error!.code).toBe(-32602);
    expect(res.find((r) => r.id === null)!.error!.code).toBe(-32700);
  });

  it("runs as a CLI subcommand on stdin/stdout, logging only to stderr", async () => {
    await writeSpec(DECISIONS);
    const stdin = new PassThrough();
    let out = "";
    let err = "";
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => ((out += String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => ((err += String(chunk)), true));
    try {
      const running = runCli(["node", "decree-harness", "--no-color", "-C", root, "mcp"]);
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
      stdin.write(`${JSON.stringify(call(2, { paths: ["src/db/x.ts"] }))}\n`);
      stdin.end();
      expect(await running).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    const res = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(res.map((r) => r.id)).toEqual([1, 2]);
    expect(res[1].result.content[0].text).toContain("adr-0003-use-postgres");
    expect(err).toContain("serving decisions from");
  });
});
