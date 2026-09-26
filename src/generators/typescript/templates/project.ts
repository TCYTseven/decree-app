import type { TsModel } from "../model.js";
import { oneLine, packageName } from "../render.js";

export function packageJson(m: TsModel): string {
  const pkg = {
    name: packageName(m.spec.name),
    version: "0.1.0",
    private: true,
    description: oneLine(m.spec.description),
    type: "module",
    engines: { node: ">=18.17" },
    scripts: {
      start: "tsx src/cli.ts",
      chat: "tsx src/cli.ts",
      eval: "tsx src/evals.ts",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      "@anthropic-ai/sdk": "^0.128.0",
    },
    devDependencies: {
      "@types/node": "^22.10.0",
      tsx: "^4.20.0",
      typescript: "^5.9.3",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function tsconfigJson(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      types: ["node"],
    },
    include: ["src/**/*.ts"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

export function gitignore(): string {
  return ["node_modules/", ".env", "memories/", ""].join("\n");
}

export function envExample(m: TsModel): string {
  const lines = [`# Environment for ${oneLine(m.spec.displayName)}. Copy to .env and fill in.`, ""];
  for (const env of m.env) {
    const tags = [env.required ? "required" : "optional", env.secret ? "secret" : undefined].filter(Boolean).join(", ");
    lines.push(`# ${oneLine(env.description)} (${tags})`);
    lines.push(`${env.name}=${env.secret ? "" : oneLine(env.default ?? "")}`);
    lines.push("");
  }
  lines.push("# Optional overrides");
  lines.push("# PROJECT_ROOT=/path/to/project   (defaults to the project this harness was generated for)");
  lines.push("# AGENT_MODEL=claude-opus-5        (overrides the model id in src/config.ts)");
  lines.push("");
  return lines.join("\n");
}
