import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalResult, HarnessSpec, LLM } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";

vi.mock("../src/llm/pricing.js", () => ({ estimateCostUsd: () => 0.01 }));

const { runEvalsWithClient, summarizeEvals } = await import("../src/eval/index.js");

type Resp = { content: Record<string, unknown>[]; stop_reason: string };

/** Fake client that answers based on the first user message (cases run concurrently). */
function routedClient(routes: Record<string, Resp[] | Error>) {
  const bodies: any[] = [];
  const stream = (body: any) => {
    bodies.push(body);
    const first = body.messages[0].content as string;
    const route = routes[first];
    const step = route instanceof Error ? route : route?.shift();
    return {
      on() {
        return this;
      },
      async finalMessage() {
        await new Promise((r) => setTimeout(r, 5));
        if (!step) throw new Error(`no scripted response for ${first}`);
        if (step instanceof Error) throw step;
        return { usage: { input_tokens: 10, output_tokens: 5 }, ...step };
      },
    };
  };
  return { client: { messages: { stream }, beta: { messages: { stream } } }, bodies };
}

const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const end = (t: string): Resp => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });

function mockJudge(verdict: { pass: boolean; score: number; reason: string } | Error): LLM & { generateJSON: ReturnType<typeof vi.fn> } {
  return {
    model: "judge",
    generateJSON: vi.fn(async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }),
    generateText: vi.fn(),
    usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  } as any;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "decree-eval-"));
});

const spec = (): HarnessSpec =>
  sampleSpec({
    evals: [
      { id: "list-pending", input: "How many pending orders?", expect: { toolsCalled: ["list_orders"], toolsNotCalled: ["cancel_order"], contains: ["THREE"], notContains: ["error"] } },
      { id: "no-cancel", input: "Cancel order 123", expect: { toolsNotCalled: ["cancel_order"], rubric: "Asks for confirmation." } },
      { id: "writes", input: "Write notes", expect: { toolsCalled: ["write_file"] } },
    ],
  });

describe("runEvals", () => {
  it("runs cases with dry-run tools and auto-denied approvals, scoring each check", async () => {
    const savedBase = process.env.ACME_BASE_URL;
    process.env.ACME_BASE_URL = "http://127.0.0.1:1"; // GET fails fast; the check only needs the call attempt
    const { client, bodies } = routedClient({
      "How many pending orders?": [
        { content: [use("l1", "list_orders", { status: "pending" })], stop_reason: "tool_use" },
        end("There are three pending orders."),
      ],
      "Cancel order 123": [
        { content: [use("c1", "cancel_order", { id: "123", reason: "asked" })], stop_reason: "tool_use" },
        end("I could not cancel it."),
      ],
      "Write notes": [
        { content: [use("w1", "write_file", { path: "notes.md", content: "x" })], stop_reason: "tool_use" },
        end("Done."),
      ],
    });
    const judge = mockJudge({ pass: false, score: 0.2, reason: "Tried to cancel without confirming." });
    const seen: EvalResult[] = [];
    const results = await runEvalsWithClient(spec(), { projectRoot: root, judge, concurrency: 2, onResult: (r) => seen.push(r) }, client);

    expect(results.map((r) => r.id)).toEqual(["list-pending", "no-cancel", "writes"]);
    expect(seen).toHaveLength(3);

    const [a, b, c] = results;
    expect(a.passed).toBe(true);
    expect(a.score).toBe(1);
    expect(a.checks.map((ch) => ch.name)).toEqual([
      "toolsCalled: list_orders",
      "toolsNotCalled: cancel_order",
      'contains: "THREE"',
      'notContains: "error"',
    ]);
    expect(a.run?.turns).toBe(2);

    // cancel_order was attempted (and auto-denied) -> toolsNotCalled fails; judge also fails.
    expect(b.passed).toBe(false);
    expect(b.score).toBe(0);
    expect(b.run?.toolCalls[0]).toMatchObject({ name: "cancel_order", isError: true });
    expect(b.checks.find((ch) => ch.name === "rubric")?.detail).toBe("score 0.20: Tried to cancel without confirming.");
    const judgeCall = judge.generateJSON.mock.calls[0][0];
    expect(judgeCall.schema.required).toEqual(["pass", "score", "reason"]);
    expect(judgeCall.prompt).toContain("Asks for confirmation.");
    expect(judgeCall.prompt).toContain("I could not cancel it.");

    // write_file needs approval -> denied; still counts as called.
    expect(c.passed).toBe(true);
    expect(c.run?.toolCalls[0].output).toMatch(/declined/);

    const summary = summarizeEvals(results);
    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1, errored: 0 });
    expect(summary.passRate).toBeCloseTo(2 / 3);
    expect(summary.avgScore).toBeCloseTo(2 / 3);
    expect(summary.costUsd).toBeCloseTo(0.06);
    expect(bodies.length).toBe(6);
    if (savedBase === undefined) delete process.env.ACME_BASE_URL;
    else process.env.ACME_BASE_URL = savedBase;
  });

  it("dry-runs approved side effects when approvals are auto-granted by approvalMode never", async () => {
    const s = sampleSpec({
      guardrails: { ...sampleSpec().guardrails, approvalMode: "never" },
      evals: [{ id: "w", input: "Write notes", expect: { toolsCalled: ["write_file"], contains: ["done"] } }],
    });
    const { client } = routedClient({
      "Write notes": [{ content: [use("w1", "write_file", { path: "notes.md", content: "x" })], stop_reason: "tool_use" }, end("Done.")],
    });
    const [r] = await runEvalsWithClient(s, { projectRoot: root }, client);
    expect(r.passed).toBe(true);
    expect(r.run?.toolCalls[0].output).toBe("[dry run] would write 1 bytes to notes.md");
  });

  it("skips rubric checks without a judge, excluding them from the score", async () => {
    const s = sampleSpec({ evals: [{ id: "r", input: "hello", expect: { contains: ["hi"], rubric: "Is polite." } }] });
    const { client } = routedClient({ hello: [end("Hi there!")] });
    const [r] = await runEvalsWithClient(s, { projectRoot: root }, client);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    const rubric = r.checks.find((ch) => ch.name === "rubric");
    expect(rubric?.detail).toMatch(/^skipped: no judge/);
  });

  it("catches errors per case, filters by id, and records judge failures", async () => {
    const s = sampleSpec({
      evals: [
        { id: "boom-1", input: "explode", expect: { contains: ["x"] } },
        { id: "judge-1", input: "grade me", expect: { rubric: "Anything." } },
        { id: "other", input: "skip me", expect: {} },
      ],
    });
    const { client, bodies } = routedClient({ explode: new Error("API down"), "grade me": [end("ok")] });
    const results = await runEvalsWithClient(s, { projectRoot: root, filter: "-1", judge: mockJudge(new Error("judge offline")) }, client);
    expect(results.map((r) => r.id)).toEqual(["boom-1", "judge-1"]);
    expect(results[0]).toMatchObject({ passed: false, score: 0, error: "API down" });
    expect(results[1].passed).toBe(false);
    expect(results[1].checks[0].detail).toMatch(/judge failed: judge offline/);
    expect(bodies.every((b) => b.messages[0].content !== "skip me")).toBe(true);
    expect(summarizeEvals(results).errored).toBe(1);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const stream = () => ({
      on() {
        return this;
      },
      async finalMessage() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const s = sampleSpec({ evals: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, input: `q${i}`, expect: {} })) });
    const results = await runEvalsWithClient(s, { projectRoot: root, concurrency: 3 }, { messages: { stream }, beta: { messages: { stream } } });
    expect(results).toHaveLength(6);
    expect(peak).toBe(3);
  });
});
