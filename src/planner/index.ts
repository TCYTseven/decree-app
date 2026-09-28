import type { Decision, HarnessSpec, LLM, ProjectProfile, Target } from "../core/types.js";
import { hasDecisionsTool, withDecisions, withoutDecisionsPromptLine } from "../decisions/tool.js";
import { DECREE_VERSION, DEFAULT_MODEL } from "../version.js";
import { renderProfileDigest } from "./digest.js";
import { groundDraft, looksLikeDraft, validateOrMerge, safeValidate } from "./grounding.js";
import { httpDefaults, planHeuristic } from "./heuristic.js";
import { planWithLLM, isOutputError } from "./llm.js";
import { REFINE_SCHEMA, REFINE_SYSTEM } from "./prompts.js";
import { isPlainObject } from "./util.js";

export { planHeuristic } from "./heuristic.js";
export { renderProfileDigest } from "./digest.js";
export { planWithLLM } from "./llm.js";

export interface PlanOptions {
  goal: string;
  targets: Target[];
  llm?: LLM; // when absent, use offline heuristics
  model?: string; // model id written into spec.model.id
  critique?: boolean; // run a critic pass after the first draft (default true when llm present)
  /** Team decisions (from src/decisions/extract) to store in the spec and serve through get_decisions. */
  decisions?: Decision[];
  onProgress?: (message: string) => void;
}

export async function planHarness(profile: ProjectProfile, opts: PlanOptions): Promise<HarnessSpec> {
  let spec: HarnessSpec;
  if (opts.llm) {
    // The architect never sees decisions; the get_decisions tool and its prompt line are added afterwards.
    spec = withDecisions(await planWithLLM(profile, { ...opts, llm: opts.llm }), opts.decisions);
  } else {
    opts.onProgress?.("Analyzing project");
    const draft = planHeuristic(profile, { goal: opts.goal, targets: opts.targets, model: opts.model, decisions: opts.decisions });
    opts.onProgress?.("Validating");
    const v = safeValidate(draft);
    spec = v.ok ? v.spec : draft;
  }
  return {
    ...spec,
    version: 1,
    model: { ...spec.model, id: opts.model ?? DEFAULT_MODEL },
    targets: opts.targets?.length ? [...opts.targets] : spec.targets,
    provenance: {
      ...spec.provenance,
      decreeVersion: DECREE_VERSION,
      createdAt: new Date().toISOString(),
      profileName: profile.name,
    },
  };
}

/** Apply natural-language feedback to an existing spec ("add a tool that...", "make it read-only"). */
export async function refineHarness(
  spec: HarnessSpec,
  feedback: string,
  opts: { llm: LLM; profile?: ProjectProfile; onProgress?: (message: string) => void },
): Promise<HarnessSpec> {
  const progress = opts.onProgress ?? (() => {});
  progress("Refining harness");
  // Decisions are the team's record, not the model's to rewrite: they (and the tool serving them) stay out of the
  // prompt and are re-attached to the result.
  const { provenance, version: _v, targets: _t, $schema: _s, decisions, ...rest0 } = spec;
  const editable = decisions
    ? { ...rest0, tools: spec.tools.filter((t) => t.kind !== "decisions"), systemPrompt: withoutDecisionsPromptLine(spec.systemPrompt) }
    : rest0;
  const firstHttp = spec.tools.find((t) => t.http)?.http;
  const defaults = firstHttp
    ? { baseUrlEnv: firstHttp.baseUrlEnv, defaultBaseUrl: firstHttp.defaultBaseUrl, auth: firstHttp.auth ?? { type: "none" as const } }
    : opts.profile
      ? httpDefaults(opts.profile)
      : undefined;
  const prompt = `${opts.profile ? `<project_digest>\n${renderProfileDigest(opts.profile, { maxChars: 40000 })}\n</project_digest>\n\n` : ""}<current_spec>
${JSON.stringify({ ...editable, notes: provenance.notes ?? [] }, null, 1)}
</current_spec>

<feedback>
${feedback}
</feedback>

Apply the feedback and return the changes you made and the full revised spec.`;

  let raw: unknown;
  try {
    raw = await opts.llm.generateJSON<unknown>({ system: REFINE_SYSTEM, prompt, schema: REFINE_SCHEMA, effort: "high", maxTokens: 64000 });
  } catch (e) {
    if (!isOutputError(e)) throw e;
    throw new Error(`Could not apply the feedback: the model's response was unusable (${(e as Error).message}). The spec was not changed.`);
  }
  const revised = isPlainObject(raw) ? raw.spec : undefined;
  if (!looksLikeDraft(revised)) {
    throw new Error("Could not apply the feedback: the model did not return a usable spec. The spec was not changed.");
  }
  progress("Validating");
  const changes = isPlainObject(raw) && Array.isArray(raw.changes) ? raw.changes.filter((c): c is string => typeof c === "string") : [];
  const grounded = groundDraft(revised, { profile: opts.profile, httpDefaults: defaults });
  const { notes: _n, ...rest } = grounded.spec;
  const m = isPlainObject(rest.model) ? rest.model : {};
  const candidate: Record<string, unknown> = {
    ...rest,
    version: 1,
    model: { ...spec.model, ...(typeof m.effort === "string" ? { effort: m.effort } : {}), ...(m.thinking === "off" || m.thinking === "adaptive" ? { thinking: m.thinking } : {}) },
    targets: spec.targets,
    provenance,
  };
  const result = validateOrMerge(candidate, { ...spec, tools: editable.tools });
  const notes = [
    ...(provenance.notes ?? []),
    `refined: ${feedback}`,
    ...changes.map((c) => `refine: ${c}`),
    ...grounded.notes.map((n) => `Grounding: ${n}`),
    ...(result.merged ? [`Part of the refinement failed validation (${result.errors.slice(0, 3).join("; ")}); kept the previous values for those fields.`] : []),
  ];
  const refined: HarnessSpec = { ...result.spec, provenance: { ...provenance, notes } };
  if (!decisions) return refined;
  // Put the decisions tool back where it was dropped (at the end), then make sure the prompt still points at it.
  const tools = hasDecisionsTool(spec) ? [...refined.tools, ...spec.tools.filter((t) => t.kind === "decisions")] : refined.tools;
  return withDecisions({ ...refined, tools }, decisions);
}
