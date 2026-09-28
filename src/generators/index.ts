import type { GeneratedFile, GenerateOptions, HarnessSpec, Target } from "../core/types.js";
import { generateTypescript } from "./typescript/index.js";
import { generatePython } from "./python/index.js";
import { generateMcp } from "./mcp/index.js";
import { generateClaudeCode } from "./claude-code/index.js";
import { generateCommon } from "./common/index.js";

export const TARGET_DIRS: Record<Target, string> = {
  typescript: "typescript",
  python: "python",
  mcp: "mcp-server",
  "claude-code": "claude-code",
};

const GENERATORS = {
  typescript: generateTypescript,
  python: generatePython,
  mcp: generateMcp,
  "claude-code": generateClaudeCode,
} as const;

/**
 * Render every requested target. Each target lives in its own subdirectory of
 * the output dir; common files (README, evals, .env.example) sit at the root.
 */
export function generateTargets(spec: HarnessSpec, targets: Target[], opts: GenerateOptions): GeneratedFile[] {
  const files: GeneratedFile[] = [...generateCommon(spec, opts)];
  const withTargets: GenerateOptions = { ...opts, targets: opts.targets ?? targets };
  for (const target of targets) {
    const dir = TARGET_DIRS[target];
    for (const f of GENERATORS[target](spec, withTargets)) {
      files.push({ ...f, path: `${dir}/${f.path}` });
    }
  }
  return files;
}
