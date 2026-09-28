import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { GeneratedFile, HarnessSpec, ToolSpec } from "../src/core/types.js";
import { generateTypescript } from "../src/generators/typescript/index.js";
import { sampleSpec } from "./helpers/sample-spec.js";
import { withDecisions } from "../src/decisions/tool.js";

const TMP = path.resolve("test/.tmp/gen-typescript");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };
const FS_KINDS = ["read_file", "write_file", "list_files", "search"];

const BASE_FILES = [
  ".env.example",
  ".gitignore",
  "README.md",
  "package.json",
  "src/agent.ts",
  "src/cli.ts",
  "src/client.ts",
  "src/config.ts",
  "src/evals.ts",
  "src/loop.ts",
  "src/prompt.ts",
  "src/session.ts",
  "src/tools/index.ts",
  "src/types.ts",
  "src/validate.ts",
  "tsconfig.json",
];

function render(name: string, spec: HarnessSpec): { dir: string; files: GeneratedFile[] } {
  const files = generateTypescript(spec, OPTS);
  // A `typescript/` leaf mirrors the real layout; module resolution walks up to the repo's node_modules.
  const dir = path.join(TMP, name, "typescript");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
  return { dir, files };
}

function byPath(files: GeneratedFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

/** Type-check a rendered project with its own tsconfig, using the repo's TypeScript and node_modules. */
function typecheck(dir: string): string[] {
  const configPath = path.join(dir, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed || parsed.fileNames.length === 0) throw new Error(`could not load ${configPath}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${path.relative(dir, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : "";
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

/** Evaluate a generated module that has no imports (prompt.ts) and return its exports. */
async function evaluate(source: string): Promise<Record<string, unknown>> {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const NASTY = "Back`tick `${process.exit(1)}` \\n \"double\" 'single' \\ backslash */ end-comment\nnew line\r\ncrlf ${x} $ {y}   </script>";

function nastySpec(): HarnessSpec {
  const base = sampleSpec();
  const tools: ToolSpec[] = base.tools.map((t) => ({
    ...t,
    description: `${t.description} ${NASTY}`,
    source: `${t.source} */ ${NASTY}`,
  }));
  tools.push({ ...tools[4], name: "read file!*/", description: NASTY }); // needs sanitizing
  tools.push({ ...tools[4], name: "read_file", description: "duplicate name" }); // needs deduping
  tools.push({
    ...tools[3],
    name: "shell`${}`",
    shell: { command: "echo {{msg}} `whoami` ${HOME} \"q\" 'x'", cwd: "." },
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string", description: NASTY, enum: [NASTY, "`"] }, "weird-key": { type: "string" } },
      required: ["msg"],
    },
  });
  return sampleSpec({
    displayName: `Nasty ${NASTY}`,
    description: NASTY,
    goal: NASTY,
    systemPrompt: `# Prompt\n${NASTY}\n\`\`\`ts\nconst s = \`\${a}\`;\n\`\`\``,
    tools,
    subagents: [
      {
        name: "weird-agent`${}`",
        description: NASTY,
        systemPrompt: NASTY,
        tools: ["read file!*/", "read_file", "missing_tool"],
        model: `claude-${NASTY}`,
      },
    ],
    evals: [{ id: `id ${NASTY}`, input: NASTY, expect: { contains: [NASTY], rubric: NASTY } }],
    env: [...base.env, { name: "WEIRD", description: `multi\nline | pipe ${NASTY}`, required: false, secret: false, default: NASTY }],
    guardrails: { ...base.guardrails, blockedCommands: [NASTY, "rm -rf /"], redactEnv: ["WEIRD"] },
  });
}

const VARIANTS: Record<string, () => HarnessSpec> = {
  sample: () => sampleSpec(),
  decisions: () =>
    withDecisions(sampleSpec(), [
      { id: "adr-0001-db", title: "Database", constraint: "Only src/db writes SQL.", status: "live", governs: ["src/db/**"], source: "docs/adr/0001-db.md" },
    ]),
  "no-subagents": () => sampleSpec({ subagents: [] }),
  "no-http": () => {
    const base = sampleSpec();
    return sampleSpec({
      tools: base.tools.filter((t) => t.kind !== "http"),
      env: base.env.filter((e) => !e.name.startsWith("ACME")),
    });
  },
  "context-off": () =>
    sampleSpec({
      context: { caching: false, compaction: false, contextEditing: false, memory: false },
      model: { id: "claude-sonnet-4-6", effort: "medium", subagentId: "claude-haiku-4-5", thinking: "off" },
      guardrails: { ...sampleSpec().guardrails, maxCostUsd: undefined, approvalMode: "always" },
      tools: sampleSpec().tools.filter((t) => t.kind !== "memory"),
    }),
  "context-editing": () => sampleSpec({ context: { caching: true, compaction: true, contextEditing: true, memory: true } }),
  "only-fs": () =>
    sampleSpec({
      tools: sampleSpec().tools.filter((t) => FS_KINDS.includes(t.kind)),
      subagents: [],
      context: { caching: true, compaction: false, contextEditing: false, memory: false },
      env: [],
      evals: [],
    }),
  "no-tools": () =>
    sampleSpec({ tools: [], subagents: [], context: { caching: false, compaction: false, contextEditing: false, memory: false } }),
  nasty: nastySpec,
};

describe("generateTypescript", () => {
  it("renders the expected layout for the sample spec", () => {
    const { files } = render("layout", sampleSpec());
    expect(files.map((f) => f.path).sort()).toEqual(
      [...BASE_FILES, "src/subagents.ts", "src/tools/fs.ts", "src/tools/http.ts", "src/tools/memory.ts", "src/tools/shell.ts"].sort(),
    );
    for (const f of files) expect(f.path).not.toMatch(/^\/|\\|\.\./);
  });

  it("emits only the tool helpers the spec needs", () => {
    const paths = (spec: HarnessSpec) => generateTypescript(spec, OPTS).map((f) => f.path);
    const onlyFs = paths(VARIANTS["only-fs"]());
    expect(onlyFs).toContain("src/tools/fs.ts");
    for (const p of ["src/tools/http.ts", "src/tools/shell.ts", "src/tools/memory.ts", "src/subagents.ts"]) {
      expect(onlyFs).not.toContain(p);
    }
    expect(paths(VARIANTS["no-http"]())).not.toContain("src/tools/http.ts");
    expect(paths(VARIANTS["no-subagents"]())).not.toContain("src/subagents.ts");
    expect(paths(VARIANTS["no-tools"]()).sort()).toEqual([...BASE_FILES].sort());
  });

  it("is deterministic", () => {
    for (const make of Object.values(VARIANTS)) {
      expect(generateTypescript(make(), OPTS)).toEqual(generateTypescript(make(), OPTS));
    }
  });

  it("writes a package.json and tsconfig for a standalone project", () => {
    const files = byPath(generateTypescript(sampleSpec(), OPTS));
    const pkg = JSON.parse(files["package.json"]);
    expect(pkg.name).toBe("acme-ops-agent");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@anthropic-ai/sdk"]).toBe("^0.128.0");
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "tsx", "typescript"]);
    expect(pkg.scripts).toMatchObject({ start: "tsx src/cli.ts", chat: expect.any(String), eval: expect.any(String), typecheck: "tsc --noEmit" });
    const tsconfig = JSON.parse(files["tsconfig.json"]);
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("uses .js suffixes on every relative import", () => {
    for (const f of generateTypescript(sampleSpec(), OPTS)) {
      if (!f.path.endsWith(".ts")) continue;
      for (const [, spec] of f.content.matchAll(/from "(\.[^"]*)"/g)) expect(spec, `${f.path}: ${spec}`).toMatch(/\.js$/);
    }
  });

  it("declares tools per the architecture: server tools by type, custom tools with schemas, spec order", () => {
    const files = byPath(generateTypescript(sampleSpec(), OPTS));
    const registry = files["src/tools/index.ts"];
    expect(registry).toContain('type: "web_search_20260209", name: "web_search", max_uses: 5');
    expect(registry).toContain('type: "memory_20250818", name: "memory"');
    const order = [...registry.matchAll(/^ {6}name: "([^"]+)"/gm)].map((m) => m[1]);
    expect(order).toEqual(["list_orders", "get_order", "cancel_order", "run_tests", "read_file", "write_file", "list_files", "search_code"]);
    expect(files["src/subagents.ts"]).toContain('toolName: "delegate_to_test_triager"');
    expect(files["src/subagents.ts"]).toContain('model: "claude-sonnet-5"');
    expect(files["src/config.ts"]).toContain("compaction: true");
    expect(files["src/loop.ts"]).toContain('"compact-2026-01-12"');
    expect(files["src/loop.ts"]).toContain("The user declined this action. Ask them how to proceed.");
  });

  it("escapes hostile spec strings safely", async () => {
    const spec = nastySpec();
    const { files } = render("nasty-escape", spec);
    const byFile = byPath(files);
    const prompt = await evaluate(byFile["src/prompt.ts"]);
    expect(prompt.SYSTEM_PROMPT).toBe(spec.systemPrompt);
    const registry = byFile["src/tools/index.ts"];
    expect(registry).toContain(JSON.stringify(`${spec.tools[0].description}`));
    expect(registry).toContain('name: "read_file_2"');
    expect(registry).toContain('name: "read_file___"');
    // Subagent references resolve to the first tool with that spec name; unknown names are dropped.
    expect(byFile["src/subagents.ts"]).toContain('tools: ["read_file___", "read_file"]');
    expect(byFile["src/subagents.ts"]).toContain('toolName: "delegate_to_weird_agent_____"');
    for (const line of byFile[".env.example"].split("\n")) expect(line === "" || /^#|^[A-Z_]+=/.test(line), line).toBe(true);
  });

  describe("type-checks with tsc", () => {
    for (const [name, make] of Object.entries(VARIANTS)) {
      it(name, () => {
        const { dir } = render(name, make());
        expect(typecheck(dir)).toEqual([]);
      }, 120_000);
    }
  });
});

describe("missing API key UX (QA regression)", () => {
  it("evals stop before running any case, and errors don't dump SDK internals", () => {
    const files = byPath(generateTypescript(sampleSpec(), { outDir: "agent", decreeVersion: "x" }));
    const evals = files["src/evals.ts"]!;
    expect(evals).toMatch(/if \(!process\.env\.ANTHROPIC_API_KEY && !process\.env\.ANTHROPIC_AUTH_TOKEN\)/);
    expect(evals.indexOf("ANTHROPIC_API_KEY is not set")).toBeLessThan(evals.indexOf("for (const c of cases)"));
    expect(files["src/client.ts"]).toContain("ANTHROPIC_API_KEY is not set.");
    expect(Object.values(files).join("\n")).toMatch(/IGNORED_DIRS = new Set\(\[[^\]]*"\.venv"/);
  });
});
