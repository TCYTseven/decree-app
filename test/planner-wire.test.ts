/**
 * planHarness / refineHarness with the real createLLM talking to a fake Messages API over HTTP.
 * The fake plays the architect, then the critic; the wire format is what the real API would send
 * (x-json-string fields arrive as JSON text inside the structured-output JSON).
 */
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HarnessSpec, ProjectProfile } from "../src/core/types.js";
import { validateSpec } from "../src/core/spec.js";
import { createLLM } from "../src/llm/client.js";
import { toStrictSchema } from "../src/llm/schema.js";
import { planHarness, refineHarness } from "../src/planner/index.js";
import { ARCHITECT_SYSTEM, CRITIC_SCHEMA, CRITIC_SYSTEM, DRAFT_SCHEMA, REFINE_SCHEMA, REFINE_SYSTEM } from "../src/planner/prompts.js";
import { scanProject } from "../src/scanner/index.js";
import { architectDraft, criticRevision, GOAL, idProp } from "./helpers/acme-drafts.js";
import { jsonReply, startFakeAnthropic, strictSchemaProblems, type FakeAnthropic } from "./helpers/fake-anthropic.js";

const FIXTURE = path.resolve(__dirname, "fixtures/express-openapi");

let fake: FakeAnthropic;
let profile: ProjectProfile;
const savedBase = process.env.ANTHROPIC_BASE_URL;

beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  profile = await scanProject(FIXTURE);
});
afterAll(async () => {
  await fake.close();
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBase;
});
beforeEach(() => {
  fake.requests.length = 0;
});

describe("planHarness over the wire", () => {
  it("architect -> critic -> grounding produces a valid, grounded spec", async () => {
    fake.setHandler((req, i) => {
      if (i === 0) return jsonReply(architectDraft(), { usage: { input_tokens: 9000, output_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      return jsonReply(
        { scores: { grounding: 3, toolSurface: 4, descriptions: 3, safety: 2, systemPrompt: 3, evals: 3 }, changes: ["Removed refund_order (no such endpoint).", "Gated cancel_order."], spec: criticRevision() },
        { usage: { input_tokens: 12000, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      );
    });
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const progress: string[] = [];
    const spec = await planHarness(profile, { goal: GOAL, targets: ["typescript"], llm, onProgress: (m) => progress.push(m) });

    // Two requests: architect then critic.
    expect(fake.requests).toHaveLength(2);
    const [arch, critic] = fake.requests.map((r) => r.body);
    expect(arch.system).toBe(ARCHITECT_SYSTEM);
    expect(critic.system).toBe(CRITIC_SYSTEM);
    const archPrompt: string = arch.messages[0].content;
    expect(archPrompt).toContain("<project_digest>");
    expect(archPrompt).toContain("acme-orders");
    expect(archPrompt).toContain("/orders/{id}/cancel");
    expect(archPrompt).toContain(GOAL);
    expect(archPrompt).toContain("<candidate_tools>");
    expect(archPrompt).toContain('"name":"run_db_migrate"');
    expect(archPrompt).toContain("baseUrlEnv: ACME_ORDERS_BASE_URL");
    const criticPrompt: string = critic.messages[0].content;
    expect(criticPrompt).toContain("<draft_spec>");
    expect(criticPrompt).toContain("<grounding_report>");
    expect(criticPrompt).toMatch(/refund_order.*not an endpoint/);
    expect(criticPrompt).not.toMatch(/"name": "refund_order"/); // the critic sees the grounded draft

    // Structured output schemas the API accepts, with headroom under the complexity limits.
    for (const body of [arch, critic]) {
      expect(body.output_config.effort).toBe("high");
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.max_tokens).toBe(64000);
      const check = strictSchemaProblems(body.output_config.format.schema);
      expect(check.problems).toEqual([]);
    }
    expect(arch.output_config.format.schema).toEqual(toStrictSchema(DRAFT_SCHEMA));
    expect(critic.output_config.format.schema).toEqual(toStrictSchema(CRITIC_SCHEMA));

    // Request sizes stay sane for a small project (system + digest + candidates + schema).
    expect(fake.requests[0]!.size).toBeLessThan(80_000);
    expect(fake.requests[1]!.size).toBeLessThan(100_000);

    // Final spec
    const v = validateSpec(spec);
    expect(v.ok).toBe(true);
    expect(spec.provenance.generator).toBe("llm");
    expect(spec.tools.map((t) => t.name)).toEqual(["list_orders", "get_order", "cancel_order", "run_tests", "read_file"]);
    expect(spec.tools.find((t) => t.name === "cancel_order")!.requiresApproval).toBe(true);
    expect(spec.tools.find((t) => t.name === "get_order")!.http!.path).toBe("/orders/{id}");
    expect(spec.tools.find((t) => t.name === "get_order")!.inputSchema).toEqual({ type: "object", properties: idProp, required: ["id"] });
    expect(spec.evals.map((e) => e.id)).toEqual(["lookup-order", "cancel-needs-confirmation", "out-of-scope"]);
    // Empty arrays / empty rubric from the strict schema are not kept as checks.
    expect(spec.evals[0]!.expect).toEqual({ toolsCalled: ["get_order"] });
    expect(spec.model.id).toBe("claude-opus-5");
    expect(spec.model.effort).toBe("medium");
    const notes = spec.provenance.notes ?? [];
    expect(notes).toContain("Removed the refund tool: no refund endpoint exists.");
    expect(notes.some((n) => n.startsWith("Critic scores for the first draft: grounding 3/5"))).toBe(true);
    expect(notes).toContain("Critic: Gated cancel_order.");
    expect(progress).toEqual(expect.arrayContaining(["Analyzing project", "Designing harness", "Critiquing design", "Validating"]));
    expect(llm.usage()).toEqual({ inputTokens: 21000, outputTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("without the critic, grounding alone drops the hallucinated endpoint and gates destructive tools", async () => {
    fake.setHandler(() => jsonReply(architectDraft()));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const spec = await planHarness(profile, { goal: GOAL, targets: ["typescript", "mcp"], llm, critique: false, model: "claude-sonnet-5" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.model).toBe("claude-opus-5"); // planner model is the LLM's; spec model is separate
    expect(validateSpec(spec).ok).toBe(true);
    expect(spec.model.id).toBe("claude-sonnet-5");
    expect(spec.targets).toEqual(["typescript", "mcp"]);
    expect(spec.tools.map((t) => t.name)).not.toContain("refund_order");
    expect(spec.tools.find((t) => t.name === "cancel_order")!.requiresApproval).toBe(true);
    expect(spec.evals.find((e) => e.id === "refund")).toBeUndefined(); // no checks left after dropping the tool
    const notes = (spec.provenance.notes ?? []).join("\n");
    expect(notes).toMatch(/Grounding: Dropped http tool "refund_order": POST \/orders\/\{id\}\/refund is not an endpoint/);
    expect(notes).toMatch(/Grounding: "cancel_order" is destructive, so it now requires approval/);
  });

  it("falls back to the heuristic plan when the architect's output is unusable twice", async () => {
    fake.setHandler(() => ({ content: [{ type: "text", text: "I cannot produce JSON right now" }], stop_reason: "end_turn" }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const spec = await planHarness(profile, { goal: GOAL, targets: ["typescript"], llm });
    expect(fake.requests).toHaveLength(2); // one parse retry, then fallback
    expect(spec.provenance.generator).toBe("heuristic");
    expect(validateSpec(spec).ok).toBe(true);
    expect((spec.provenance.notes ?? [])[0]).toMatch(/Architect output was unusable/);
  });

  it("propagates auth errors instead of silently falling back", async () => {
    fake.setHandler(() => ({ status: 401, type: "authentication_error", message: "invalid x-api-key" }));
    const llm = createLLM({ apiKey: "sk-ant-bad" });
    await expect(planHarness(profile, { goal: GOAL, targets: ["typescript"], llm })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("refineHarness over the wire", () => {
  it('applies "make it read-only" and keeps the spec valid', async () => {
    fake.setHandler(() => jsonReply(criticRevision()));
    const llm0 = createLLM({ apiKey: "sk-ant-fake" });
    const base: HarnessSpec = await planHarness(profile, { goal: GOAL, targets: ["typescript"], llm: llm0, critique: false });
    fake.requests.length = 0;

    const revised = criticRevision();
    revised.tools = revised.tools.filter((t: any) => t.readOnly);
    revised.evals = revised.evals.filter((e: any) => e.id !== "cancel-needs-confirmation");
    revised.evals.forEach((e: any) => (e.expect.toolsNotCalled = []));
    revised.systemPrompt = "You are a read-only support agent for the Acme orders service.";
    fake.setHandler(() => jsonReply({ changes: ["Removed cancel_order.", "Updated the system prompt to read-only."], spec: revised }));
    const llm = createLLM({ apiKey: "sk-ant-fake" });
    const out = await refineHarness(base, "make it read-only", { llm, profile });
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]!.body;
    expect(body.system).toBe(REFINE_SYSTEM);
    expect(body.output_config.format.schema).toEqual(toStrictSchema(REFINE_SCHEMA));
    expect(strictSchemaProblems(body.output_config.format.schema).problems).toEqual([]);
    expect(body.messages[0].content).toContain("<feedback>\nmake it read-only\n</feedback>");
    expect(body.messages[0].content).toContain("<current_spec>");
    expect(validateSpec(out).ok).toBe(true);
    expect(out.tools.every((t) => t.readOnly)).toBe(true);
    expect(out.provenance.notes).toEqual(expect.arrayContaining(["refined: make it read-only", "refine: Removed cancel_order."]));
    expect(out.provenance.createdAt).toBe(base.provenance.createdAt);
  });
});

describe("planner schemas", () => {
  it("stay within the structured-output limits with headroom", () => {
    for (const s of [DRAFT_SCHEMA, CRITIC_SCHEMA, REFINE_SCHEMA]) {
      const r = strictSchemaProblems(toStrictSchema(s));
      expect(r.problems).toEqual([]);
      expect(r.optional).toBeLessThanOrEqual(18);
      expect(r.unions).toBe(0);
    }
  });
});
