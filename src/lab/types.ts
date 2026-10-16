import type { LocalModel } from "./endpoints.js";

/**
 * The lab's eval vocabulary, framed the way Google DeepMind reports evaluations:
 *
 *   - Capability evaluations, one row per domain, each named after the public benchmark it
 *     mirrors (IFEval, FACTS Grounding, MRCR, BFCL ...) and scored as accuracy with a 95%
 *     confidence interval over items x samples, like a model card's results table.
 *   - Safety evaluations, framed after the Frontier Safety Framework: each domain has an
 *     alert threshold (a violation rate). Crossing it is an early warning to review the model
 *     before trusting it with this harness, not a verdict.
 *
 * Every item is graded by code (verifiable checks), so a run needs no judge model and no network.
 */

export type DomainArea = "capability" | "safety";

export type DomainId =
  | "instruction-following"
  | "grounding"
  | "long-context"
  | "function-calling"
  | "decision-adherence"
  | "repo-navigation"
  | "unsafe-actions"
  | "prompt-injection"
  | "harmful-requests";

export type Grader =
  | { type: "called"; tool: string; args?: Record<string, string> }
  | { type: "called_any"; tools: string[] }
  | { type: "not_called"; tools: string[] }
  | { type: "no_tools" }
  | { type: "contains_all"; values: string[] }
  | { type: "contains_any"; values: string[]; label?: string }
  | { type: "not_contains"; values: string[]; label?: string }
  | { type: "json"; shape: "array" | "object"; keys?: string[]; includes?: string[] }
  | { type: "max_words"; n: number }
  | { type: "max_sentences"; n: number }
  | { type: "bullets"; n: number }
  | { type: "line_count"; n: number }
  | { type: "lowercase" }
  | { type: "starts_with"; phrase: string }
  | { type: "ends_with"; phrase: string };

export interface LabItem {
  id: string;
  domain: DomainId;
  /** chat: one plain turn, no tools. agent: the harness's own agent loop with tools in dry-run mode. */
  kind: "chat" | "agent";
  prompt: string;
  /** chat items only; agent items use the harness system prompt. */
  system?: string;
  graders: Grader[];
  tags?: string[];
  /** Long-context items: approximate prompt size in tokens, and the context Ollama should allocate. */
  tokens?: number;
  numCtx?: number;
  /** Shown in the dashboard instead of a huge prompt. */
  summary?: string;
}

export interface DomainSpec {
  id: DomainId;
  area: DomainArea;
  title: string;
  /** The public benchmark this domain is modelled on, as cited in DeepMind model cards. */
  benchmark: string;
  description: string;
  /** Safety only: violation rate at or above which the domain raises an alert. */
  alertThreshold?: number;
  /** Agent domains need the model to call tools. */
  needsTools: boolean;
}

export interface DomainPlan extends DomainSpec {
  items: LabItem[];
  /** Why the domain has no items for this harness or model (shown as "n/a" in the card). */
  skipped?: string;
}

/** How the suite was fitted to one local model. */
export interface Tailoring {
  model: string;
  contextLength: number;
  contextSource: "server" | "assumed";
  tools: boolean | "unknown";
  /** Size class from the parameter count: drives output budgets and turn caps. */
  tier: "small" | "medium" | "large" | "unknown";
  maxTurns: number;
  maxOutputTokens: number;
  longContextTokens: number[];
  notes: string[];
}

export interface LabSuite {
  version: 1;
  generatedAt: string;
  project: string;
  harness: string;
  /** Hash of the inputs (spec + tailoring): the same inputs give the same suite. */
  fingerprint: string;
  seed: number;
  tailoring?: Tailoring;
  domains: DomainPlan[];
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ItemResult {
  id: string;
  domain: DomainId;
  sample: number;
  passed: boolean;
  score: number;
  checks: CheckResult[];
  answer: string;
  toolCalls: { name: string; isError: boolean }[];
  turns: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface DomainScore {
  id: DomainId;
  area: DomainArea;
  title: string;
  benchmark: string;
  status: "ran" | "skipped";
  reason?: string;
  items: number;
  trials: number;
  passed: number;
  /** Capability: accuracy. Safety: violation rate (1 - pass rate). */
  rate: number;
  ci: [number, number];
  alertThreshold?: number;
  alert?: boolean;
  errors: number;
}

export interface ModelRun {
  model: LocalModel;
  tailoring: Tailoring;
  status: "done" | "failed" | "stopped";
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  domains: DomainScore[];
  /** Macro average over capability domains that ran. */
  capabilityScore?: number;
  /** How many capability domains that average covers, out of how many the suite has. */
  capabilityCoverage?: { ran: number; total: number };
  alerts: number;
  tokensPerSecond?: number;
  results: ItemResult[];
}

export interface LabRun {
  version: 1;
  id: string;
  project: string;
  harness: string;
  startedAt: string;
  finishedAt?: string;
  samples: number;
  temperature: number;
  models: ModelRun[];
}

export type LabEvent =
  | { type: "model_start"; key: string; model: string; tailoring: Tailoring; total: number }
  | { type: "item"; key: string; result: ItemResult; done: number; total: number }
  | { type: "model_done"; key: string; run: Omit<ModelRun, "results"> }
  | { type: "log"; key?: string; message: string };
