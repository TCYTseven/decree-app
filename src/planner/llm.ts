/**
 * LLM planner: architect -> critic -> deterministic grounding -> validation.
 *
 * 1. Analyze: render a compact digest and run the heuristic planner for candidate tools.
 * 2. Architect (effort high): design a full spec grounded in the candidates.
 * 3. Critic (effort high, optional): score against a rubric and return a revised spec.
 * 4. Ground + validate: drop hallucinated endpoints, enforce approval on destructive tools,
 *    validateSpec; fall back to merging with the heuristic spec when output is unusable.
 */
import type { HarnessSpec, LLM, ProjectProfile, Target, ToolSpec } from "../core/types.js";
import { DECREE_VERSION, DEFAULT_MODEL, DEFAULT_SUBAGENT_MODEL } from "../version.js";
import { renderProfileDigest } from "./digest.js";
import { groundDraft, looksLikeDraft, validateOrMerge, type GroundingContext } from "./grounding.js";
import { planHeuristicDetailed, type HeuristicPlan } from "./heuristic.js";
import { ARCHITECT_SYSTEM, CRITIC_SCHEMA, CRITIC_SYSTEM, DRAFT_SCHEMA } from "./prompts.js";
import { isPlainObject } from "./util.js";

export interface LLMPlanOptions {
  goal: string;
  targets: Target[];
  llm: LLM;
  model?: string;
  critique?: boolean;
  onProgress?: (message: string) => void;
}

const MAX_TOKENS = 64000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Compact JSON of candidate tools for the prompt (schemas elided when the list is large). */
export function renderCandidates(tools: ToolSpec[], maxChars = 40000): string {
  const full = tools.map((t) => ({
    name: t.name,
    kind: t.kind,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.http ? { http: t.http } : {}),
    ...(t.shell ? { shell: t.shell } : {}),
    ...(t.fs ? { fs: t.fs } : {}),
    readOnly: t.readOnly,
    destructive: t.destructive,
    requiresApproval: t.requiresApproval,
    source: t.source,
  }));
  let text = full.map((t) => JSON.stringify(t)).join("\n");
  if (text.length <= maxChars) return text;
  const slim = full.map((t) => {
    const props = isPlainObject(t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [];
    return { ...t, inputSchema: `properties: ${props.join(", ") || "none"}; required: ${((t.inputSchema.required as string[]) ?? []).join(", ") || "none"}` };
  });
  text = slim.map((t) => JSON.stringify(t)).join("\n");
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n…(more candidates omitted)";
}

function progressReporter(label: string, onProgress?: (m: string) => void): ((chars: number) => void) | undefined {
  if (!onProgress) return undefined;
  let last = 0;
  return (chars: number) => {
    if (chars - last < 4000) return;
    last = chars;
    onProgress(`${label} (${(chars / 1000).toFixed(0)}k chars)`);
  };
}

function specForPrompt(spec: Record<string, unknown>): string {
  const { provenance: _p, version: _v, targets: _t, $schema: _s, ...rest } = spec;
  return JSON.stringify(rest, null, 1);
}

/** Wrap a grounded draft into a full spec shape (identity fields filled in by code, not the model). */
export function assembleSpec(
  draft: Record<string, unknown>,
  base: HarnessSpec,
  opts: { model?: string; targets: Target[]; generator: "llm" | "heuristic"; notes: string[]; profileName: string },
): Record<string, unknown> {
  const { notes: _n, ...rest } = draft;
  const m = isPlainObject(draft.model) ? draft.model : {};
  return {
    ...rest,
    version: 1,
    model: {
      id: opts.model ?? DEFAULT_MODEL,
      effort: typeof m.effort === "string" && EFFORTS.has(m.effort) ? m.effort : base.model.effort,
      subagentId: typeof m.subagentId === "string" && m.subagentId ? m.subagentId : base.model.subagentId || DEFAULT_SUBAGENT_MODEL,
      thinking: m.thinking === "off" ? "off" : "adaptive",
    },
    targets: [...opts.targets],
    provenance: {
      generator: opts.generator,
      decreeVersion: DECREE_VERSION,
      createdAt: new Date().toISOString(),
      profileName: opts.profileName,
      notes: opts.notes,
    },
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

export async function planWithLLM(profile: ProjectProfile, opts: LLMPlanOptions): Promise<HarnessSpec> {
  const progress = opts.onProgress ?? (() => {});
  progress("Analyzing project");
  const digest = renderProfileDigest(profile);
  const heuristic: HeuristicPlan = planHeuristicDetailed(profile, { goal: opts.goal, targets: opts.targets, model: opts.model });
  const base = heuristic.spec;
  const goal = base.goal;
  const candidates = renderCandidates(base.tools);
  const gctx: GroundingContext = { profile, httpDefaults: heuristic.httpDefaults };
  const d = heuristic.httpDefaults;
  const facts = [
    `baseUrlEnv: ${d.baseUrlEnv}`,
    d.defaultBaseUrl ? `defaultBaseUrl: ${d.defaultBaseUrl}` : "defaultBaseUrl: unknown (leave unset)",
    `auth: ${d.auth.type === "bearer" ? `bearer, env ${d.auth.env}` : "none detected"}`,
    heuristic.testCommand ? `test command: ${heuristic.testCommand}` : "test command: none detected",
    `agent slug suggestion: ${base.name}`,
  ].join("\n");

  // --- Architect -----------------------------------------------------------
  progress("Designing harness");
  const architectPrompt = `<project_digest>
${digest}
</project_digest>

<goal>
${goal}
</goal>

<targets>${opts.targets.join(", ")}</targets>

<harness_defaults>
${facts}
</harness_defaults>

<candidate_tools>
These were derived mechanically from the project's real endpoints, scripts, and the goal (one JSON object per line). Select, merge, rename, and rewrite them as the goal requires; any other tool you add must still bind to a real endpoint or script from the digest.
${candidates}
</candidate_tools>

Design the harness for this goal and return the complete specification.`;

  const planNotes: string[] = [];
  let draftRaw: unknown;
  try {
    draftRaw = await opts.llm.generateJSON<unknown>({
      system: ARCHITECT_SYSTEM,
      prompt: architectPrompt,
      schema: DRAFT_SCHEMA,
      effort: "high",
      maxTokens: MAX_TOKENS,
      onProgress: progressReporter("Designing harness", opts.onProgress),
    });
  } catch (e) {
    if (!isOutputError(e)) throw e;
    planNotes.push(`Architect output was unusable (${(e as Error).message}); used the heuristic plan.`);
    draftRaw = undefined;
  }

  if (!looksLikeDraft(draftRaw)) {
    if (draftRaw !== undefined) planNotes.push("Architect output did not look like a harness spec; used the heuristic plan.");
    progress("Validating");
    return finalizeFallback(base, planNotes, opts);
  }

  const archNotes = strings(draftRaw.notes);
  const grounded = groundDraft(draftRaw, gctx);
  let chosen = grounded;
  let groundingNotes = grounded.notes;
  let critiqueNotes: string[] = [];

  // --- Critic --------------------------------------------------------------
  if (opts.critique !== false) {
    progress("Critiquing design");
    const criticPrompt = `<project_digest>
${digest}
</project_digest>

<goal>
${goal}
</goal>

<harness_defaults>
${facts}
</harness_defaults>

<candidate_tools>
${candidates}
</candidate_tools>

<draft_spec>
${specForPrompt(grounded.spec)}
</draft_spec>
${
  grounded.notes.length
    ? `
<grounding_report>
An automated check already adjusted the draft:
${grounded.notes.map((n) => `- ${n}`).join("\n")}
</grounding_report>
`
    : ""
}
Review the draft against the rubric and return your scores, the changes you made, and the revised full spec.`;
    try {
      const critic = await opts.llm.generateJSON<unknown>({
        system: CRITIC_SYSTEM,
        prompt: criticPrompt,
        schema: CRITIC_SCHEMA,
        effort: "high",
        maxTokens: MAX_TOKENS,
        onProgress: progressReporter("Critiquing design", opts.onProgress),
      });
      if (isPlainObject(critic) && looksLikeDraft(critic.spec)) {
        const revised = groundDraft(critic.spec, gctx);
        const scores = isPlainObject(critic.scores)
          ? Object.entries(critic.scores)
              .map(([k, v]) => `${k} ${v}/5`)
              .join(", ")
          : "";
        critiqueNotes = [
          ...(scores ? [`Critic scores for the first draft: ${scores}.`] : []),
          ...strings(critic.changes).map((c) => `Critic: ${c}`),
        ];
        // Only adopt the revision if it validates; otherwise keep the architect's draft.
        const trial = validateOrMerge(assembleSpec(revised.spec, base, { ...meta(opts, profile), notes: [] }), base);
        if (!trial.merged) {
          chosen = revised;
          groundingNotes = revised.notes;
          if (strings(revised.spec.notes).length) archNotes.splice(0, archNotes.length, ...strings(revised.spec.notes));
        } else {
          critiqueNotes.push("Critic revision failed validation; kept the architect's draft.");
        }
      } else {
        critiqueNotes.push("Critic returned no usable revision; kept the architect's draft.");
      }
    } catch (e) {
      if (!isOutputError(e)) throw e;
      critiqueNotes.push(`Critic step failed (${(e as Error).message}); kept the architect's draft.`);
    }
  }

  // --- Validate ------------------------------------------------------------
  progress("Validating");
  const notes = [...archNotes, ...critiqueNotes, ...groundingNotes.map((n) => `Grounding: ${n}`), ...planNotes];
  const assembled = assembleSpec(chosen.spec, base, { ...meta(opts, profile), notes });
  const result = validateOrMerge(assembled, base);
  const spec = result.spec;
  if (result.merged) {
    spec.provenance = {
      ...spec.provenance,
      generator: "llm",
      notes: [
        ...notes,
        `LLM design failed validation (${result.errors.slice(0, 3).join("; ")}); merged the valid parts with the heuristic plan.`,
      ],
    };
  }
  return spec;
}

function meta(opts: LLMPlanOptions, profile: ProjectProfile) {
  return { model: opts.model, targets: opts.targets, generator: "llm" as const, profileName: profile.name };
}

function finalizeFallback(base: HarnessSpec, notes: string[], opts: LLMPlanOptions): HarnessSpec {
  return {
    ...base,
    model: { ...base.model, id: opts.model ?? DEFAULT_MODEL },
    targets: [...opts.targets],
    provenance: { ...base.provenance, generator: "heuristic", notes: [...notes, ...(base.provenance.notes ?? [])] },
  };
}

/**
 * Errors caused by the model's output (unparseable JSON, schema mismatch, refusal, truncation) are
 * recoverable: the planner falls back. Transport/auth errors propagate so the CLI can report them.
 */
export function isOutputError(e: unknown): boolean {
  if (e instanceof SyntaxError) return true;
  const err = e as { name?: string; message?: string; status?: number; kind?: string };
  if (err?.name === "LLMError" && typeof err.kind === "string") return ["parse", "refusal", "max_tokens"].includes(err.kind);
  if (typeof err?.status === "number") return false; // API error from the SDK
  const msg = `${err?.name ?? ""} ${err?.message ?? ""}`;
  if (/api key|authentication|unauthori[sz]ed|permission|rate.?limit|overloaded|ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network|abort/i.test(msg)) return false;
  return /json|schema|pars|valid|refus|max_tokens|truncat|incomplete|unexpected|structured|output/i.test(msg);
}
