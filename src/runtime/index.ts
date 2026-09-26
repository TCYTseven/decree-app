import type { HarnessSpec, RunOptions, RunResult } from "../core/types.js";

/** Run the harness described by `spec` live against Claude, executing tools locally. */
export async function runAgent(spec: HarnessSpec, opts: RunOptions): Promise<RunResult> {
  throw new Error("runAgent: not implemented");
}
