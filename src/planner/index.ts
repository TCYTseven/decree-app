import type { HarnessSpec, LLM, ProjectProfile, Target } from "../core/types.js";

export interface PlanOptions {
  goal: string;
  targets: Target[];
  llm?: LLM; // when absent, use offline heuristics
  model?: string; // model id written into spec.model.id
  critique?: boolean; // run a critic pass after the first draft (default true when llm present)
  onProgress?: (message: string) => void;
}

export async function planHarness(profile: ProjectProfile, opts: PlanOptions): Promise<HarnessSpec> {
  throw new Error("planHarness: not implemented");
}

/** Apply natural-language feedback to an existing spec ("add a tool that...", "make it read-only"). */
export async function refineHarness(
  spec: HarnessSpec,
  feedback: string,
  opts: { llm: LLM; profile?: ProjectProfile; onProgress?: (message: string) => void },
): Promise<HarnessSpec> {
  throw new Error("refineHarness: not implemented");
}
