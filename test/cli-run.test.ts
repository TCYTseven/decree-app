import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOptions, RunResult } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const runAgent = vi.fn<(spec: unknown, opts: RunOptions) => Promise<RunResult>>();
vi.mock("../src/runtime/index.js", () => ({ runAgent: (spec: unknown, opts: RunOptions) => runAgent(spec, opts) }));

const { runCli } = await import("../src/commands/program.js");

let stdout = "";
let stderr = "";
let root: string;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => ((stdout += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => ((stderr += String(chunk)), true));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cli-run-"));
  await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec()));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  runAgent.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await fs.rm(root, { recursive: true, force: true });
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  finalText: "There are 3 pending orders.",
  turns: 2,
  toolCalls: [{ name: "list_orders", input: { status: "pending" }, output: "[]", isError: false }],
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.001,
  messages: [],
  stopReason: "end_turn",
  ...over,
});

describe("run command", () => {
  it("--json prints the RunResult on stdout only", async () => {
    runAgent.mockImplementation(async (_spec, opts) => {
      opts.onEvent?.({ type: "text", text: "There are 3" });
      opts.onEvent?.({ type: "tool_call", id: "1", name: "list_orders", input: {} });
      return result();
    });
    const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "run", "how", "many", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.finalText).toContain("3 pending");
    expect(runAgent.mock.calls[0][1].prompt).toBe("how many");
    expect(runAgent.mock.calls[0][1].projectRoot).toBe(root);
  });

  it("streams text and exits non-zero when the run reports an error", async () => {
    runAgent.mockImplementation(async (_spec, opts) => {
      opts.onEvent?.({ type: "text", text: "partial" });
      opts.onEvent?.({ type: "error", message: "Stopped: reached guardrails.maxTurns (30)." });
      return result({ stopReason: null });
    });
    const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "run", "hi"]);
    expect(code).toBe(1);
    expect(stdout).toContain("partial");
    expect(stderr).toContain("maxTurns");
  });

  it("--yes auto-approves and warns", async () => {
    let approved: boolean | undefined;
    runAgent.mockImplementation(async (spec, opts) => {
      const tool = sampleSpec().tools.find((t) => t.name === "cancel_order")!;
      approved = await opts.approve?.({ name: tool.name, input: { id: "1" }, tool });
      return result();
    });
    expect(await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "run", "cancel", "--yes"])).toBe(0);
    expect(approved).toBe(true);
    expect(stderr).toContain("auto-approved");
  });

  it("declines approvals when no terminal is attached", async () => {
    let approved: boolean | undefined;
    runAgent.mockImplementation(async (_spec, opts) => {
      const tool = sampleSpec().tools.find((t) => t.name === "cancel_order")!;
      approved = await opts.approve?.({ name: tool.name, input: { id: "1" }, tool });
      return result();
    });
    expect(await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "run", "cancel", "--json"])).toBe(0);
    expect(approved).toBe(false);
  });
});
