import type { EvalResult, HarnessSpec, LLM } from "../core/types.js";

export interface EvalOptions {
  projectRoot: string;
  apiKey?: string;
  judge?: LLM; // used for rubric grading
  filter?: string; // only run cases whose id includes this
  concurrency?: number; // default 2
  dryRunTools?: boolean; // default true: tools describe instead of execute
  onResult?: (r: EvalResult) => void;
}

export async function runEvals(spec: HarnessSpec, opts: EvalOptions): Promise<EvalResult[]> {
  throw new Error("runEvals: not implemented");
}
