import type { GeneratedFile, GenerateOptions, HarnessSpec } from "../../core/types.js";
import { buildContext } from "./context.js";
import { agentPy } from "./templates/agent.js";
import { cliPy, dotenvPy } from "./templates/cli.js";
import { configPy } from "./templates/config.js";
import { evalsPy } from "./templates/evals.js";
import { envExample, initPy, mainPy, pyprojectToml, readmeMd } from "./templates/project.js";
import { promptPy } from "./templates/prompt.js";
import { subagentsPy } from "./templates/subagents.js";
import { testToolsPy } from "./templates/tests.js";
import { toolsBasePy } from "./templates/tools-base.js";
import { toolsFsPy } from "./templates/tools-fs.js";
import { toolsHttpPy } from "./templates/tools-http.js";
import { toolsInitPy } from "./templates/tools-init.js";
import { toolsMemoryPy } from "./templates/tools-memory.js";
import { toolsRegistryPy } from "./templates/tools-registry.js";
import { toolsShellPy } from "./templates/tools-shell.js";

export { pythonPackageName } from "./py.js";

/**
 * Render a standalone Python agent harness for the spec. Pure and deterministic:
 * the same spec and options always produce byte-identical files. Paths are
 * relative to the target dir (the dispatcher prefixes `python/`).
 */
export function generatePython(spec: HarnessSpec, opts: GenerateOptions): GeneratedFile[] {
  const ctx = buildContext(spec, opts);
  const { pkg, has } = ctx;
  const files: [string, string][] = [
    ["pyproject.toml", pyprojectToml(ctx)],
    ["README.md", readmeMd(ctx)],
    [".env.example", envExample(ctx)],
    [`${pkg}/__init__.py`, initPy(ctx)],
    [`${pkg}/__main__.py`, mainPy(ctx)],
    [`${pkg}/config.py`, configPy(ctx)],
    [`${pkg}/prompt.py`, promptPy(ctx)],
    [`${pkg}/dotenv.py`, dotenvPy(ctx)],
    [`${pkg}/tools/__init__.py`, toolsInitPy(ctx)],
    [`${pkg}/tools/base.py`, toolsBasePy(ctx)],
    [`${pkg}/tools/registry.py`, toolsRegistryPy(ctx)],
  ];
  if (has.http) files.push([`${pkg}/tools/http.py`, toolsHttpPy(ctx)]);
  if (has.shell) files.push([`${pkg}/tools/shell.py`, toolsShellPy(ctx)]);
  if (has.fs) files.push([`${pkg}/tools/fs.py`, toolsFsPy(ctx)]);
  if (has.memory) files.push([`${pkg}/tools/memory.py`, toolsMemoryPy(ctx)]);
  if (has.subagents) files.push([`${pkg}/subagents.py`, subagentsPy(ctx)]);
  files.push(
    [`${pkg}/agent.py`, agentPy(ctx)],
    [`${pkg}/cli.py`, cliPy(ctx)],
    [`${pkg}/evals.py`, evalsPy(ctx)],
    ["tests/test_tools.py", testToolsPy(ctx)],
  );
  return files.map(([path, content]) => ({ path, content: tidy(content) }));
}

/** Strip trailing whitespace and end with exactly one newline. */
function tidy(content: string): string {
  return content.replace(/[ \t]+$/gm, "").replace(/\s*$/, "\n");
}
