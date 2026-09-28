/**
 * decree-harness programmatic API.
 *
 *   import { scanProject, planHarness, generateTargets } from "decree-harness";
 */
export * from "./core/types.js";
export { scanProject, type ScanOptions } from "./scanner/index.js";
export { planHarness, refineHarness, type PlanOptions } from "./planner/index.js";
export { generateTargets, TARGET_DIRS } from "./generators/index.js";
export { runAgent } from "./runtime/index.js";
export {
  extractDecisions,
  mergeDecisions,
  scopeDecisions,
  rankDecisions,
  formatDecisions,
  globMatches,
  withDecisions,
  type ExtractResult,
  type MergeResult,
  type ScopeOptions,
} from "./decisions/index.js";
export { runEvals, type EvalOptions } from "./eval/index.js";
export { validateSpec, specJsonSchema } from "./core/spec.js";
export { createLLM, resolveApiKey, MissingApiKeyError } from "./llm/client.js";
export { estimateCostUsd } from "./llm/pricing.js";
export { loadSpec, saveSpec, loadProfile, saveProfile, projectPaths, serializeSpec } from "./core/config.js";
export { writeFiles, type WriteOptions, type WriteReport } from "./core/writer.js";
export { buildProgram, runCli } from "./commands/program.js";
export { DECREE_VERSION, DEFAULT_MODEL, DEFAULT_SUBAGENT_MODEL } from "./version.js";
