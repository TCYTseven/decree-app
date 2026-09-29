import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalResult } from "../src/core/types.js";
import { stripAnsi } from "../src/ui/theme.js";
import { newToken } from "../src/cloud/api.js";
import { seedToken, startFakeDecree } from "./helpers/fake-decree.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const runEvals = vi.fn<(spec: unknown, opts: { onResult?: (r: EvalResult) => void; dryRunTools?: boolean }) => Promise<EvalResult[]>>();
vi.mock("../src/eval/index.js", () => ({ runEvals: (s: unknown, o: never) => runEvals(s, o) }));

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cli-eval-"));
  await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec()));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await fs.rm(root, { recursive: true, force: true });
});

const results: EvalResult[] = [
  { id: "list-pending", passed: true, score: 1, checks: [{ name: "called list_orders", passed: true }], run: { finalText: "3", turns: 2, toolCalls: [], costUsd: 0.01 } },
  {
    id: "no-cancel-without-confirm",
    passed: false,
    score: 0.5,
    checks: [
      { name: "did not call cancel_order", passed: false, detail: "cancel_order was called" },
      { name: "rubric", passed: true },
    ],
    run: { finalText: "done", turns: 3, toolCalls: [{ name: "cancel_order", input: {}, output: "", isError: false }], costUsd: 0.02 },
  },
];

describe("eval command", () => {
  it("prints a results table, failure details, and exits 1 when any fail", async () => {
    runEvals.mockImplementation(async (_s, o) => {
      results.forEach((r) => o.onResult?.(r));
      return results;
    });
    const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "eval"]);
    expect(code).toBe(1);
    const out = stripAnsi(stdout);
    expect(out).toContain("list-pending");
    expect(out).toContain("cancel_order was called");
    expect(out).toContain("1/2 passed");
    expect(runEvals.mock.calls[0][1].dryRunTools).toBe(true);
  });

  it("--json prints a summary and passes with exit 0 when all pass", async () => {
    runEvals.mockResolvedValue([results[0]]);
    const code = await runCli(["node", "decree-harness", "--cwd", root, "eval", "--json", "--filter", "list", "--live-tools"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.passed).toBe(1);
    expect(runEvals.mock.calls.at(-1)![1].dryRunTools).toBe(false);
  });

  it("unknown filter is a friendly error", async () => {
    const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "eval", "--filter", "zzz"]);
    expect(code).toBe(1);
    expect(stderr).toContain('No eval ids match "zzz"');
  });

  it("--push uploads the run with the spec it ran against", async () => {
    const fake = await startFakeDecree();
    const token = newToken();
    seedToken(fake, token);
    const saved = { url: process.env.DECREE_API_URL, token: process.env.DECREE_TOKEN };
    process.env.DECREE_API_URL = fake.url;
    process.env.DECREE_TOKEN = token;
    try {
      runEvals.mockResolvedValue(results);
      const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "eval", "--push"]);
      expect(code).toBe(1); // one eval failed; the upload still happened
      const req = fake.requests.find((r) => r.path === "/api/v1/evals")!;
      const body = req.body as { spec: { name: string }; evals: { summary: { passed: number; total: number }; results: { toolCalls: string[] }[]; model: string } };
      expect(body.spec.name).toBe(sampleSpec().name);
      expect(body.evals.summary).toMatchObject({ passed: 1, total: 2 });
      expect(body.evals.results[1].toolCalls).toEqual(["cancel_order"]);
      expect(body.evals.model).toBe(sampleSpec().model.id);
      expect(stripAnsi(stdout)).toContain(`/dashboard/harnesses/${sampleSpec().name}`);
    } finally {
      process.env.DECREE_API_URL = saved.url;
      if (saved.token === undefined) delete process.env.DECREE_TOKEN;
      else process.env.DECREE_TOKEN = saved.token;
      if (saved.url === undefined) delete process.env.DECREE_API_URL;
      await fake.close();
    }
  });

  it("--push without a login fails before running any evals", async () => {
    const saved = { dir: process.env.DECREE_CONFIG_DIR, token: process.env.DECREE_TOKEN };
    process.env.DECREE_CONFIG_DIR = root;
    delete process.env.DECREE_TOKEN;
    runEvals.mockClear();
    try {
      const code = await runCli(["node", "decree-harness", "--no-color", "--cwd", root, "eval", "--push"]);
      expect(code).toBe(1);
      expect(stderr).toContain("Not logged in");
      expect(runEvals).not.toHaveBeenCalled();
    } finally {
      if (saved.dir === undefined) delete process.env.DECREE_CONFIG_DIR;
      else process.env.DECREE_CONFIG_DIR = saved.dir;
      if (saved.token !== undefined) process.env.DECREE_TOKEN = saved.token;
    }
  });
});
