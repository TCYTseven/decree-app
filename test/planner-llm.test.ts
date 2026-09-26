import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/spec.js";
import { LLMError } from "../src/llm/client.js";
import { planHarness, refineHarness } from "../src/planner/index.js";
import { toStrictSchema } from "../src/llm/schema.js";
import { CRITIC_SCHEMA, DRAFT_SCHEMA, REFINE_SCHEMA } from "../src/planner/prompts.js";
import { MockLLM } from "./helpers/mock-llm.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

const GOAL = "Help on-call engineers inspect orders, run tests, and triage failures.";

/** A draft as the architect would return it (x-json-string fields already decoded). */
function draft(mutate?: (d: Record<string, any>) => void): Record<string, any> {
  const { provenance: _p, version: _v, targets: _t, model, ...rest } = sampleSpec();
  const d: Record<string, any> = JSON.parse(JSON.stringify({ ...rest, model: { effort: model.effort, thinking: model.thinking }, notes: ["Kept the tool surface small."] }));
  // Hallucinated endpoint: not in the profile.
  d.tools.push({
    name: "wipe_orders",
    description: "Delete every order.",
    kind: "http",
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method: "DELETE", baseUrlEnv: "ACME_BASE_URL", path: "/admin/orders" },
    readOnly: false,
    destructive: true,
    requiresApproval: true,
    source: "invented",
  });
  // Unsafe flags on a real destructive endpoint; path uses :id style.
  const cancel = d.tools.find((t: any) => t.name === "cancel_order");
  cancel.requiresApproval = false;
  cancel.http.path = "/orders/:id/cancel";
  // Model returns inputSchema as a JSON string (the real client decodes, but be tolerant).
  const get = d.tools.find((t: any) => t.name === "get_order");
  get.inputSchema = JSON.stringify(get.inputSchema);
  d.evals.push({ id: "wipe", input: "wipe it all", expect: { toolsNotCalled: ["wipe_orders"] } });
  mutate?.(d);
  return d;
}

describe("planHarness with an LLM", () => {
  it("runs architect + critic, grounds the result, and records notes", async () => {
    const critic = { scores: { grounding: 2, toolSurface: 4, descriptions: 4, safety: 2, systemPrompt: 4, evals: 3 }, changes: ["Gated cancel_order behind approval."], spec: draft() };
    const llm = new MockLLM([draft(), critic]);
    const progress: string[] = [];
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript", "python"], llm, onProgress: (m) => progress.push(m) });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.opts.effort).toBe("high");
    expect(llm.calls[0]!.opts.prompt).toContain("<project_digest>");
    expect(llm.calls[0]!.opts.prompt).toContain("<candidate_tools>");
    expect(llm.calls[0]!.opts.prompt).toContain(GOAL);
    expect(llm.calls[0]!.opts.system).toMatch(/harness/);
    expect(llm.calls[1]!.opts.prompt).toContain("<draft_spec>");
    expect(llm.calls[1]!.opts.prompt).toContain("<grounding_report>");

    const names = spec.tools.map((t) => t.name);
    expect(names).not.toContain("wipe_orders");
    const cancel = spec.tools.find((t) => t.name === "cancel_order")!;
    expect(cancel.requiresApproval).toBe(true);
    expect(cancel.http!.path).toBe("/orders/{id}/cancel");
    expect(spec.tools.find((t) => t.name === "get_order")!.inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(spec.evals.some((e) => e.id === "wipe")).toBe(false);

    expect(spec.provenance.generator).toBe("llm");
    const notes = spec.provenance.notes!.join("\n");
    expect(notes).toContain("Critic: Gated cancel_order behind approval.");
    expect(notes).toMatch(/Critic scores/);
    expect(notes).toMatch(/Dropped http tool "wipe_orders"/);
    expect(notes).toContain("Kept the tool surface small.");
    expect(spec.targets).toEqual(["typescript", "python"]);
    expect(spec.model.id).toBe("claude-opus-5");
    expect(progress).toEqual(expect.arrayContaining(["Analyzing project", "Designing harness", "Critiquing design", "Validating"]));
    expect(validateSpec(spec).ok).toBe(true);
  });

  it("skips the critic when critique is false", async () => {
    const llm = new MockLLM([draft()]);
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm, critique: false, model: "claude-opus-5-5" });
    expect(llm.calls).toHaveLength(1);
    expect(spec.model.id).toBe("claude-opus-5-5");
    expect(spec.tools.some((t) => t.name === "wipe_orders")).toBe(false);
  });

  it("keeps the architect draft when the critic output is unusable", async () => {
    const llm = new MockLLM([draft(), { scores: {}, changes: [], spec: { nope: true } }]);
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm });
    expect(spec.provenance.generator).toBe("llm");
    expect(spec.tools.some((t) => t.name === "cancel_order")).toBe(true);
    expect(spec.provenance.notes!.join("\n")).toMatch(/Critic returned no usable revision/);
  });

  it("falls back to the heuristic plan when the architect output is garbage", async () => {
    const llm = new MockLLM([{ hello: "world" }]);
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm });
    expect(spec.provenance.generator).toBe("heuristic");
    expect(spec.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_orders", "run_tests"]));
    expect(spec.provenance.notes!.join("\n")).toMatch(/did not look like a harness spec/);
    expect(validateSpec(spec).ok).toBe(true);
  });

  it("falls back when the model output cannot be parsed, but propagates API errors", async () => {
    const parse = new MockLLM([new LLMError("parse", "Model returned invalid JSON twice")]);
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm: parse });
    expect(spec.provenance.generator).toBe("heuristic");

    const auth = new MockLLM([new LLMError("auth", "Invalid API key", { status: 401 })]);
    await expect(planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm: auth })).rejects.toThrow(/Invalid API key/);
  });

  it("merges with the heuristic plan when the draft fails validation", async () => {
    const bad = draft((d) => {
      d.guardrails = { maxTurns: "lots" };
      d.env = "nope";
    });
    const llm = new MockLLM([bad]);
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript"], llm, critique: false });
    expect(validateSpec(spec).ok).toBe(true);
    // The LLM's tools and prompt survive; the invalid guardrails come from the heuristic plan.
    expect(spec.systemPrompt).toContain("Acme Ops Agent");
    expect(spec.guardrails.maxTurns).toBeTypeOf("number");
    expect(spec.provenance.notes!.join("\n")).toMatch(/merged the valid parts/);
  });

  it("uses schemas that convert to strict structured-output schemas", () => {
    for (const s of [DRAFT_SCHEMA, CRITIC_SCHEMA, REFINE_SCHEMA]) {
      const strict = toStrictSchema(s) as any;
      const tool = (strict.properties.spec ?? strict).properties.tools.items;
      expect(tool.properties.inputSchema.type).toBe("string");
      expect(tool.additionalProperties).toBe(false);
    }
  });
});

describe("refineHarness", () => {
  it("applies feedback, grounds, and appends a provenance note", async () => {
    const base = sampleSpec();
    const revised = draft((d) => {
      d.tools = d.tools.filter((t: any) => t.name !== "write_file" && t.name !== "wipe_orders");
      d.subagents[0].tools.push("write_file");
      d.systemPrompt += "\n\nYou are read-only.";
    });
    const llm = new MockLLM([{ changes: ["Removed write_file."], spec: revised }]);
    const out: HarnessSpec = await refineHarness(base, "make it read-only", { llm, profile: sampleProfile() });

    expect(llm.calls[0]!.opts.prompt).toContain("make it read-only");
    expect(llm.calls[0]!.opts.prompt).toContain("<current_spec>");
    expect(out.tools.some((t) => t.name === "write_file")).toBe(false);
    expect(out.subagents[0]!.tools).not.toContain("write_file");
    expect(out.tools.find((t) => t.name === "cancel_order")!.requiresApproval).toBe(true);
    expect(out.provenance.createdAt).toBe(base.provenance.createdAt);
    expect(out.provenance.notes).toContain("refined: make it read-only");
    expect(out.provenance.notes).toContain("refine: Removed write_file.");
    expect(out.provenance.notes).toContain("sample spec for tests");
    expect(out.targets).toEqual(base.targets);
    expect(validateSpec(out).ok).toBe(true);
  });

  it("works without a profile and rejects unusable output", async () => {
    const ok = new MockLLM([{ changes: [], spec: draft() }]);
    const out = await refineHarness(sampleSpec(), "tighten descriptions", { llm: ok });
    // Without a profile, endpoints cannot be checked, so the invented tool is kept (but gated).
    expect(out.tools.find((t) => t.name === "wipe_orders")?.requiresApproval).toBe(true);

    const bad = new MockLLM([{ changes: [], spec: null }]);
    await expect(refineHarness(sampleSpec(), "x", { llm: bad })).rejects.toThrow(/not changed/);
  });
});
