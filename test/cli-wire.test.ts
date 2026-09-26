/**
 * End to end: the built CLI (`node dist/cli.js`) in a copy of a fixture, talking to a fake
 * Anthropic API through ANTHROPIC_BASE_URL. Rebuilds dist/ first when it is missing or stale.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, promises as fs, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHITECT_SYSTEM, CRITIC_SYSTEM, REFINE_SYSTEM } from "../src/planner/prompts.js";
import { estimateCostUsd } from "../src/llm/pricing.js";
import { architectDraft, criticRevision, GOAL } from "./helpers/acme-drafts.js";
import { jsonReply, startFakeAnthropic, textReply, type FakeAnthropic, type FakeResponse, type RecordedRequest } from "./helpers/fake-anthropic.js";

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURE = path.join(REPO, "test", "fixtures", "express-openapi");

function newestMtime(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

let fake: FakeAnthropic;
let proj: string;

/** The fake plays every role, routed by the request's system prompt. */
function route(req: RecordedRequest): FakeResponse {
  const b = req.body;
  const sys = typeof b.system === "string" ? b.system : b.system?.[0]?.text ?? "";
  const usage = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (sys === ARCHITECT_SYSTEM) return jsonReply(architectDraft(), { usage });
  if (sys === CRITIC_SYSTEM)
    return jsonReply({ scores: { grounding: 3, toolSurface: 4, descriptions: 4, safety: 3, systemPrompt: 4, evals: 3 }, changes: ["Removed refund_order."], spec: criticRevision() }, { usage });
  if (sys === REFINE_SYSTEM) {
    const d = criticRevision();
    d.tools = d.tools.filter((t: any) => t.readOnly);
    d.evals = d.evals.filter((e: any) => e.id === "lookup-order");
    d.systemPrompt = "You are a read-only support agent for the Acme orders service.";
    return jsonReply({ changes: ["Removed cancel_order to make the agent read-only."], spec: d }, { usage });
  }
  if (b.output_config?.format) return jsonReply({ pass: true, score: 1, reason: "Declined politely." }, { usage: { ...usage, input_tokens: 500, output_tokens: 50 } });
  // Runtime (harness) requests: answer directly; for the lookup eval, call get_order first.
  const first = b.messages[0]?.content;
  const u = { input_tokens: 2_000, output_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 500 };
  if (typeof first === "string" && first.includes("ord_123") && b.messages.length === 1)
    return { content: [{ type: "tool_use", name: "get_order", input: { id: "ord_123" } }], stop_reason: "tool_use", usage: u };
  return textReply("I can help with orders. I won't cancel anything without your confirmation.", { usage: u });
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: "fake", ANTHROPIC_BASE_URL: fake.url, NO_COLOR: "1", CI: "1", ...extraEnv };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.FORCE_COLOR;
    // Keep the http tools off the network (reads are live even in dry-run evals).
    env.ACME_ORDERS_BASE_URL = "http://127.0.0.1:9";
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  const stale = !existsSync(CLI) || newestMtime(path.join(REPO, "src")) > statSync(CLI).mtimeMs;
  if (stale) execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "ignore" });
  fake = await startFakeAnthropic(route);
  proj = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cli-wire-"));
  await fs.cp(FIXTURE, proj, { recursive: true });
}, 180_000);

afterAll(async () => {
  await fake?.close();
  if (proj) await fs.rm(proj, { recursive: true, force: true });
});

describe("CLI against the fake API", () => {
  it("init --yes designs with Claude, writes decree.json + code, and prints the cost", async () => {
    const r = await runCli(["init", "--yes", "--goal", GOAL, "--targets", "typescript"]);
    const out = r.stdout + r.stderr;
    expect(r.code, out).toBe(0);
    expect(fake.requests.map((q) => q.body.system)).toEqual([ARCHITECT_SYSTEM, CRITIC_SYSTEM]);
    expect(fake.requests[0]!.headers["x-api-key"]).toBe("fake");
    const spec = JSON.parse(await fs.readFile(path.join(proj, "decree.json"), "utf8"));
    expect(spec.provenance.generator).toBe("llm");
    expect(spec.tools.map((t: any) => t.name)).not.toContain("refund_order");
    expect(spec.tools.find((t: any) => t.name === "cancel_order").requiresApproval).toBe(true);
    expect(existsSync(path.join(proj, "agent", "typescript", "package.json"))).toBe(true);
    // 2 calls x (10k in, 2k out) on claude-opus-5 = (20000*5 + 4000*25)/1e6 = $0.200
    expect(estimateCostUsd("claude-opus-5", { inputTokens: 20_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.2, 10);
    expect(out).toMatch(/Planner · claude-opus-5 · 20k in · 4\.0k out · \$0\.200/);
    expect(out).toContain("API key from env");
  }, 60_000);

  it("run --json prints a RunResult with usage and cost", async () => {
    fake.requests.length = 0;
    const r = await runCli(["run", "What's", "the", "status", "of", "ord_123?", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.turns).toBe(2);
    expect(res.toolCalls[0].name).toBe("get_order");
    expect(res.toolCalls[0].isError).toBe(true); // nothing listens on port 9
    expect(res.usage).toEqual({ inputTokens: 4000, outputTokens: 200, cacheReadTokens: 2000, cacheWriteTokens: 1000 });
    // (4000*5 + 200*25 + 2000*0.5 + 1000*6.25)/1e6
    expect(res.costUsd).toBeCloseTo(0.03225, 10);
    const b = fake.requests[0]!.body;
    expect(b.model).toBe("claude-opus-5");
    expect(b.output_config).toEqual({ effort: "medium" });
    expect(b.tools.every((t: any) => t.type || t.eager_input_streaming === true)).toBe(true);
  }, 60_000);

  it("run (human output) prints turns, tokens, and cost", async () => {
    const r = await runCli(["run", "hello"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("I can help with orders.");
    expect(r.stderr).toMatch(/1 turn · 0 tool calls · 2\.0k in · 100 out · 1\.0k cached · 500 cache-write · \$0\.016/);
  }, 60_000);

  it("eval runs every case, grades rubrics, and prints the total cost", async () => {
    fake.requests.length = 0;
    const r = await runCli(["eval", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const { summary, results } = JSON.parse(r.stdout);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(results.map((x: any) => x.id)).toEqual(["lookup-order", "cancel-needs-confirmation", "out-of-scope"]);
    const judge = fake.requests.filter((q) => q.body.output_config?.format);
    expect(judge).toHaveLength(2); // two cases have rubrics
    // runs: lookup (2 turns) + 2 single-turn cases = 4 runtime turns at $0.016125; judge 2 x (500 in, 50 out)
    const expected = 4 * 0.016125 + 2 * ((500 * 5 + 50 * 25) / 1e6);
    expect(summary.costUsd).toBeCloseTo(expected, 10);

    const human = await runCli(["eval"]);
    expect(human.code, human.stdout + human.stderr).toBe(0);
    expect(human.stdout + human.stderr).toMatch(/3\/3 passed · score 100% · \$0\.072/);
  }, 60_000);

  it('refine "make it read-only" revises decree.json and regenerates', async () => {
    fake.requests.length = 0;
    const r = await runCli(["refine", "make", "it", "read-only"]);
    const out = r.stdout + r.stderr;
    expect(r.code, out).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.system).toBe(REFINE_SYSTEM);
    expect(fake.requests[0]!.body.messages[0].content).toContain("<project_digest>"); // the saved profile is sent
    const spec = JSON.parse(await fs.readFile(path.join(proj, "decree.json"), "utf8"));
    expect(spec.tools.every((t: any) => t.readOnly)).toBe(true);
    expect(spec.provenance.notes).toContain("refined: make it read-only");
    expect(out).toMatch(/- cancel_order/);
    expect(out).toMatch(/Refine · claude-opus-5 · 10k in · 2\.0k out · \$0\.100/);
  }, 60_000);

  it("a bad key fails with a friendly message and exit code 1", async () => {
    await fake.close();
    fake = await startFakeAnthropic(() => ({ status: 401, type: "authentication_error", message: "invalid x-api-key" }));
    const r = await runCli(["run", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Invalid ANTHROPIC_API_KEY|401/);
    expect(r.stderr).not.toMatch(/at .*\.js:\d+/); // no stack trace
  }, 60_000);
});
