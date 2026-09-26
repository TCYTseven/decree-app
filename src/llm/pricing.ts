import type { LLMUsage } from "../core/types.js";

/** Estimated USD cost for a usage record on a given model id. */
export function estimateCostUsd(model: string, usage: LLMUsage): number {
  throw new Error("estimateCostUsd: not implemented");
}
