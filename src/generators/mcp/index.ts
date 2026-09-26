import type { GeneratedFile, GenerateOptions, HarnessSpec } from "../../core/types.js";
import { buildModel } from "./model.js";
import { configTs } from "./templates/config.js";
import { envExample, packageJson, tsconfigJson } from "./templates/project.js";
import { readmeMd } from "./templates/readme.js";
import { harnessTs, serverTs } from "./templates/server.js";
import { toolsTs } from "./templates/tools.js";

/**
 * Render a standalone MCP server (TypeScript, stdio) exposing the spec's
 * client-executable tools and its prompts. Paths are relative to the target
 * dir; the dispatcher prefixes `mcp-server/`.
 */
export function generateMcp(spec: HarnessSpec, opts: GenerateOptions): GeneratedFile[] {
  const m = buildModel(spec, opts);
  return [
    { path: "package.json", content: packageJson(m) },
    { path: "tsconfig.json", content: tsconfigJson() },
    { path: "README.md", content: readmeMd(m) },
    { path: ".env.example", content: envExample(m) },
    { path: ".gitignore", content: "node_modules/\ndist/\n.env\n" },
    { path: "src/server.ts", content: serverTs(m), executable: true },
    { path: "src/tools.ts", content: toolsTs(m) },
    { path: "src/config.ts", content: configTs(m) },
    { path: "src/harness.ts", content: harnessTs(m) },
  ];
}
