import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeneratedFile, HarnessSpec, ToolSpec } from "../src/core/types.js";
import { generateMcp } from "../src/generators/mcp/index.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TMP = path.resolve("test/.tmp/gen-mcp");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };

const EXPECTED_FILES = [
  ".env.example",
  ".gitignore",
  "README.md",
  "package.json",
  "src/config.ts",
  "src/harness.ts",
  "src/server.ts",
  "src/tools.ts",
  "tsconfig.json",
];

function render(name: string, spec: HarnessSpec, opts = OPTS): { dir: string; files: GeneratedFile[] } {
  const files = generateMcp(spec, opts);
  const dir = path.join(TMP, name, "mcp-server");
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

function syntaxErrors(file: string, source: string): string[] {
  const out = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return (out.diagnostics ?? []).map((d) => `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

function expectValidTs(files: GeneratedFile[]): void {
  const errors = files.filter((f) => f.path.endsWith(".ts")).flatMap((f) => syntaxErrors(f.path, f.content));
  expect(errors).toEqual([]);
}

/** Import a generated module that does not depend on the MCP SDK (config/tools/harness). */
async function importGenerated<T>(dir: string, file: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, file)).href)) as T;
}

const fsTool = (over: Partial<ToolSpec> & Pick<ToolSpec, "name" | "kind">): ToolSpec => ({
  description: `${over.kind} tool`,
  inputSchema: { type: "object", properties: {} },
  fs: { root: "." },
  readOnly: over.kind !== "write_file",
  destructive: over.kind === "write_file",
  requiresApproval: over.kind === "write_file",
  ...over,
});

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));

describe("generateMcp: sampleSpec", () => {
  const spec = sampleSpec();
  const { dir, files } = render("sample", spec);
  const f = byPath(files);

  it("emits the expected layout with relative POSIX paths", () => {
    expect(files.map((x) => x.path).sort()).toEqual(EXPECTED_FILES);
    for (const x of files) {
      expect(x.path.startsWith("/")).toBe(false);
      expect(x.path.includes("\\")).toBe(false);
      expect(x.content.length).toBeGreaterThan(0);
    }
    expect(files.find((x) => x.path === "src/server.ts")?.executable).toBe(true);
    expect(fs.existsSync(path.join(dir, "src/server.ts"))).toBe(true);
  });

  it("is deterministic", () => {
    expect(generateMcp(sampleSpec(), OPTS)).toEqual(files);
  });

  it("writes a runnable package.json", () => {
    const pkg = JSON.parse(f["package.json"]!);
    expect(pkg.name).toBe("acme-ops-agent-mcp");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "acme-ops-agent-mcp": "dist/server.js" });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "tsx", "typescript"]);
    expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "start", "typecheck"]);
    expect(JSON.parse(f["tsconfig.json"]!).compilerOptions.module).toBe("NodeNext");
  });

  it("registers only client-executable tools, with annotations", () => {
    const server = f["src/server.ts"]!;
    expect(server.startsWith("#!/usr/bin/env node\n")).toBe(true);
    for (const name of ["list_orders", "get_order", "cancel_order", "run_tests", "read_file", "write_file", "list_files", "search_code"]) {
      expect(server).toContain(`server.registerTool(\n`);
      expect(server).toContain(`INPUT_SCHEMAS[${JSON.stringify(name)}]`);
    }
    expect(server).not.toContain('"web_search"');
    expect(server).not.toContain('"memory"');
    expect(server).toContain("destructiveHint: true");
    expect(server).toContain("readOnlyHint: true");
    expect(server).toContain("openWorldHint: true");
    expect(server).toContain("DESTRUCTIVE:");
    expect(server).toContain("StdioServerTransport");
    expect(server).toContain("registerPrompt");
    expect(server).toContain("registerResource");
    // prompts/get must work when clients omit "arguments".
    expect(server).toContain("setRequestHandler(GetPromptRequestSchema");
    // Nothing may print to stdout.
    for (const x of files.filter((y) => y.path.endsWith(".ts"))) {
      expect(x.content).not.toMatch(/console\.(log|info)\(|process\.stdout\.write/);
    }
    // Destructive tools are skipped in read-only mode.
    expect(server).toMatch(/if \(!READ_ONLY_MODE\) \{\n  server\.registerTool\(\n    "cancel_order"/);
  });

  it("generates zod input schemas from JSON Schema", () => {
    const tools = f["src/tools.ts"]!;
    expect(tools).toContain('"status": z.enum(["pending", "shipped", "cancelled"]).describe("Filter by status").optional()');
    expect(tools).toContain('"limit": z.number().int().describe("Max results (default 20)").optional()');
    expect(tools).toContain('"id": z.string().describe("Order id"),');
  });

  it("generated TypeScript parses", () => expectValidTs(files));

  it("README documents install, clients, env, tools and the non-exposed tools", () => {
    const readme = f["README.md"]!;
    expect(readme).toContain("claude mcp add acme-ops-agent -- npx tsx /abs/path/to/agent/mcp-server/src/server.ts");
    expect(readme).toContain('"mcpServers"');
    expect(readme).toContain("claude_desktop_config.json");
    expect(readme).toContain("| `ACME_API_TOKEN` | yes | yes |");
    expect(readme).toContain("| `cancel_order` | http | no | **yes** | confirm first |");
    expect(readme).toContain("`web_search` (web_search)");
    expect(readme).toContain("`memory` (memory)");
    expect(readme).not.toContain("| `ANTHROPIC_API_KEY` |");
    expect(f[".env.example"]).toContain("ACME_API_TOKEN=\n");
    expect(f[".env.example"]).toContain("ACME_BASE_URL=http://localhost:3000");
    expect(f[".env.example"]).not.toContain("ANTHROPIC_API_KEY");
  });

  it("exposes the agent and subagent prompts verbatim", async () => {
    const h = await importGenerated<{ PROMPTS: { name: string; text: string; tools: string[] }[]; HARNESS_SUMMARY: string }>(
      dir,
      "src/harness.ts",
    );
    expect(h.PROMPTS.map((p) => p.name)).toEqual(["acme-ops-agent", "test-triager"]);
    expect(h.PROMPTS[0]!.text).toBe(spec.systemPrompt);
    expect(h.PROMPTS[1]!.tools).toEqual(["run_tests", "read_file", "search_code", "list_files"]);
    const summary = JSON.parse(h.HARNESS_SUMMARY);
    expect(summary.notExposed.map((t: { name: string }) => t.name)).toEqual(["web_search", "memory"]);
  });

  it("appends -agent to names that lack it", () => {
    const out = byPath(generateMcp(sampleSpec({ name: "acme" }), OPTS));
    expect(out["src/harness.ts"]).toContain('name: "acme-agent"');
  });
});

describe("generateMcp: nasty strings", () => {
  const nasty = "q\"uote 'single' `back` ${inject} */ /* </script> \\ back\\slash | pipe\nnew\u2028line\u2029 é 🙂";
  const base = sampleSpec();
  const spec = sampleSpec({
    displayName: nasty,
    description: nasty,
    systemPrompt: `# Prompt\n${nasty}\n\`\`\`\ncode\n\`\`\``,
    tools: [
      {
        ...base.tools[0]!,
        name: "9-weird-name",
        description: nasty,
        inputSchema: {
          type: "object",
          description: nasty,
          properties: {
            [nasty]: { type: "string", enum: [nasty, "b"], description: nasty },
            "kebab-key": { type: ["string", "null"] },
            nested: {
              type: "object",
              properties: { deep: { type: "array", items: { type: "number" } } },
              required: ["deep"],
              additionalProperties: false,
            },
            anything: {},
            mixed: { enum: [1, "two", true, null] },
            union: { anyOf: [{ type: "string" }, { type: "integer" }] },
            map: { type: "object", additionalProperties: { type: "boolean" } },
          },
          required: [nasty],
          additionalProperties: true,
        },
        http: { ...base.tools[0]!.http!, path: `/x/{${nasty}}`, defaultBaseUrl: nasty },
      },
      { ...base.tools[3]!, description: nasty, shell: { command: `echo ${nasty} {{pattern}}` } },
      ...base.tools.slice(4),
    ],
    subagents: [{ ...base.subagents[0]!, description: nasty, systemPrompt: nasty }],
    guardrails: { ...base.guardrails, blockedCommands: [nasty], allowedPaths: [".", nasty], redactEnv: ["X"] },
    env: [{ name: "WEIRD_ENV", description: nasty, required: false, secret: false, default: nasty }],
  });
  const { dir, files } = render("nasty", spec);
  const f = byPath(files);

  it("keeps generated TypeScript syntactically valid", () => expectValidTs(files));

  it("is deterministic", () => expect(generateMcp(spec, OPTS)).toEqual(files));

  it("round-trips strings exactly through the generated modules", async () => {
    const h = await importGenerated<{ PROMPTS: { text: string; description: string }[] }>(dir, "src/harness.ts");
    expect(h.PROMPTS[0]!.text).toBe(spec.systemPrompt);
    expect(h.PROMPTS[1]!.text).toBe(nasty);
    const t = await importGenerated<{
      TOOLS: Record<string, { http?: { path: string; defaultBaseUrl?: string }; shell?: { command: string } }>;
      INPUT_SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
    }>(dir, "src/tools.ts");
    expect(t.TOOLS["9-weird-name"]!.http!.path).toBe(`/x/{${nasty}}`);
    expect(t.TOOLS["9-weird-name"]!.http!.defaultBaseUrl).toBe(nasty);
    expect(t.TOOLS["run_tests"]!.shell!.command).toBe(`echo ${nasty} {{pattern}}`);
    const schema = t.INPUT_SCHEMAS["9-weird-name"]!;
    const ok = schema.safeParse({ [nasty]: nasty, nested: { deep: [1, 2] }, mixed: "two", union: 3, extra: 1, map: { a: true } });
    expect(ok.success).toBe(true);
    expect((ok.data as Record<string, unknown>).extra).toBe(1); // additionalProperties: true
    expect(schema.safeParse({ [nasty]: "c" }).success).toBe(false); // enum
    expect(schema.safeParse({ [nasty]: "b", nested: { deep: [1], x: 1 } }).success).toBe(false); // strict nested
    expect(schema.safeParse({ [nasty]: "b", union: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ [nasty]: "b", "kebab-key": null }).success).toBe(true);
  });

  it("keeps markdown and .env single-line where it matters", () => {
    const env = f[".env.example"]!;
    for (const line of env.split("\n")) expect(line === "" || line.startsWith("#") || /^[A-Z_]+=/.test(line)).toBe(true);
    const rows = f["README.md"]!.split("\n").filter((l) => l.startsWith("| `9-weird-name`"));
    expect(rows).toHaveLength(1);
    // 6 columns => 7 unescaped pipes, whatever the description contains.
    const unescaped = rows[0]!.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 1;
    expect(unescaped).toBe(7);
  });
});

describe("generateMcp: variants", () => {
  it("no http tools: no API env vars, no fetch-bound tools", () => {
    const base = sampleSpec();
    const spec = sampleSpec({ tools: base.tools.filter((t) => t.kind !== "http"), env: [] });
    const { files } = render("no-http", spec);
    const f = byPath(files);
    expectValidTs(files);
    expect(f["src/server.ts"]).not.toContain("list_orders");
    expect(f[".env.example"]).not.toContain("ACME_");
    expect(f["README.md"]).not.toContain("| `ACME_API_TOKEN` |");
    expect(f["README.md"]).toContain("claude mcp add acme-ops-agent -- npx tsx");
    expect(f["README.md"]).not.toContain(" -e ");
  });

  it("fs-only, no subagents, absolute outDir", () => {
    const spec = sampleSpec({
      tools: [fsTool({ name: "read_file", kind: "read_file" }), fsTool({ name: "list_files", kind: "list_files" })],
      subagents: [],
      env: [],
    });
    const { files } = render("fs-only", spec, { outDir: "/abs/out", decreeVersion: "0.1.0" });
    const f = byPath(files);
    expectValidTs(files);
    expect(f["src/config.ts"]).toContain('process.env["DECREE_PROJECT_ROOT"] || process.cwd()');
    expect(f["src/server.ts"]).not.toContain("READ_ONLY_MODE) {");
    expect(f["README.md"]).not.toContain("Not exposed:");
    expect(f["README.md"]).not.toContain("Subagents are not tools");
  });

  it("no client tools at all still renders a valid server", () => {
    const spec = sampleSpec({ tools: sampleSpec().tools.filter((t) => t.kind === "web_search"), subagents: [] });
    const { files } = render("server-tools-only", spec);
    expectValidTs(files);
    expect(byPath(files)["src/server.ts"]).toContain("this harness has no client-executable tools");
  });

  it("nested outDir computes the default project root", () => {
    const f = byPath(generateMcp(sampleSpec(), { outDir: "tools/agent", decreeVersion: "0.1.0" }));
    expect(f["src/config.ts"]).toContain('path.resolve(HERE, "../../../..")');
    expect(f["README.md"]).toContain("cd tools/agent/mcp-server");
  });
});

// ---------------------------------------------------------------------------
// Functional: run the generated tool implementations (no MCP SDK needed).
// ---------------------------------------------------------------------------

type ToolsModule = {
  runTool(name: string, input: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }>;
  renderCommand(t: string, input: Record<string, unknown>): string;
  globToRegExp(g: string): RegExp;
};

describe("generated tools: behavior", () => {
  const root = path.join(TMP, "func", "project");
  let tools: ToolsModule;
  let srv: http.Server;
  let port = 0;
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

  beforeAll(async () => {
    fs.rmSync(path.join(TMP, "func"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "secret"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/index.ts"), "export const a = 1; // TODO one\n");
    fs.writeFileSync(path.join(root, "src/lib/util.ts"), "line1\n// TODO two\n");
    fs.writeFileSync(path.join(root, "src/bin.dat"), Buffer.from([0, 1, 2, 84, 79, 68, 79]));
    fs.writeFileSync(path.join(root, "node_modules/pkg/index.ts"), "// TODO ignored\n");
    fs.writeFileSync(path.join(root, "secret/key.txt"), "TODO hidden\n");
    try {
      fs.symlinkSync("/etc", path.join(root, "src/etc-link"));
    } catch {
      /* symlinks unsupported */
    }

    srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(req.url?.includes("missing") ? 404 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as { port: number }).port;

    const base = sampleSpec();
    const spec = sampleSpec({
      tools: [
        ...base.tools.filter((t) => t.kind === "http"),
        {
          ...base.tools[3]!,
          name: "echo",
          inputSchema: { type: "object", properties: { msg: { type: "string" }, n: { type: "integer" } } },
          shell: { command: "echo  {{msg}}   {{n}} ; echo token=$FUNC_TOKEN", cwd: "src" },
        },
        { ...base.tools[3]!, name: "fail", shell: { command: "exit 3" } },
        { ...base.tools[3]!, name: "slow", shell: { command: "sleep 5", timeoutMs: 200 } },
        ...base.tools.filter((t) => ["read_file", "write_file", "list_files", "search"].includes(t.kind)),
        fsTool({ name: "read_src", kind: "read_file", fs: { root: "src", maxBytes: 10 } }),
      ],
      guardrails: {
        ...base.guardrails,
        blockedCommands: ["rm -rf"],
        allowedPaths: ["src", "out"],
        redactEnv: ["FUNC_TOKEN", "ACME_API_TOKEN"],
      },
    });
    const { dir } = render("func", spec);
    process.env.DECREE_PROJECT_ROOT = root;
    process.env.ACME_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ACME_API_TOKEN = "tok-abc-123";
    process.env.FUNC_TOKEN = "s3cr3t-value";
    tools = await importGenerated<ToolsModule>(dir, "src/tools.ts");
  });

  afterAll(() => {
    srv?.close();
    delete process.env.DECREE_PROJECT_ROOT;
    delete process.env.ACME_BASE_URL;
    delete process.env.ACME_API_TOKEN;
    delete process.env.FUNC_TOKEN;
  });

  it("list_files globs, ignores node_modules, honors allowedPaths", async () => {
    const r = await tools.runTool("list_files", { pattern: "**/*.ts" });
    expect(r.isError).toBeUndefined();
    expect(text(r).split("\n")).toEqual(["src/index.ts", "src/lib/util.ts"]);
    expect(text(await tools.runTool("list_files", { pattern: "src/*" }))).not.toContain("util.ts");
  });

  it("read_file reads, truncates, and refuses escapes", async () => {
    expect(text(await tools.runTool("read_file", { path: "src/index.ts" }))).toBe("export const a = 1; // TODO one\n");
    const t = await tools.runTool("read_src", { path: "index.ts" });
    expect(text(t)).toBe("export con\n…[truncated 22 bytes]");
    for (const p of ["../outside", "/etc/passwd", "secret/key.txt", "src/etc-link/hostname"]) {
      const r = await tools.runTool("read_file", { path: p });
      expect(r.isError, p).toBe(true);
    }
  });

  it("write_file creates directories inside allowed paths only", async () => {
    const r = await tools.runTool("write_file", { path: "out/a/b.txt", content: "hé" });
    expect(text(r)).toBe("wrote 3 bytes to out/a/b.txt");
    expect(fs.readFileSync(path.join(root, "out/a/b.txt"), "utf8")).toBe("hé");
    expect((await tools.runTool("write_file", { path: "other.txt", content: "x" })).isError).toBe(true);
  });

  it("search finds matches, skips binary/ignored/disallowed files, supports glob", async () => {
    const r = await tools.runTool("search_code", { query: "TODO" });
    expect(text(r).split("\n")).toEqual(["src/index.ts:1: export const a = 1; // TODO one", "src/lib/util.ts:2: // TODO two"]);
    expect(text(await tools.runTool("search_code", { query: "TODO", glob: "util.ts" }))).toBe("src/lib/util.ts:2: // TODO two");
    expect((await tools.runTool("search_code", { query: "(" })).isError).toBe(true);
  });

  it("shell quotes params, collapses spaces, redacts, blocks, reports exit codes", async () => {
    expect(tools.renderCommand("a  {{x}}  {{y}} b", { x: "it's" })).toBe("a 'it'\\''s' b");
    expect(tools.renderCommand("a {{x}}", { x: "two  spaces" })).toBe("a 'two  spaces'");
    const r = await tools.runTool("echo", { msg: "hi  $(whoami)", n: 2 });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("exit code: 0\nhi  $(whoami) 2\ntoken=[REDACTED:FUNC_TOKEN]\n");
    const blocked = await tools.runTool("echo", { msg: "rm -rf /" });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("Refused");
    const fail = await tools.runTool("fail", {});
    expect(fail.isError).toBe(true);
    expect(text(fail)).toBe("exit code: 3\n");
    const slow = await tools.runTool("slow", {});
    expect(slow.isError).toBe(true);
    expect(text(slow)).toContain("timed out");
  });

  it("http builds URL/query/body/auth and redacts output", async () => {
    const list = await tools.runTool("list_orders", { status: "pending", limit: 5 });
    expect(text(list)).toBe(
      `HTTP 200 OK\n${JSON.stringify({ method: "GET", url: "/orders?status=pending&limit=5", auth: "Bearer [REDACTED:ACME_API_TOKEN]", body: "" })}`,
    );
    const get = await tools.runTool("get_order", { id: "a/b c" });
    expect(text(get)).toContain('"url":"/orders/a%2Fb%20c"');
    const cancel = await tools.runTool("cancel_order", { id: "7", reason: "dup" });
    expect(text(cancel)).toContain('"body":"{\\"reason\\":\\"dup\\"}"');
    const missing = await tools.runTool("get_order", { id: "missing" });
    expect(missing.isError).toBe(true);
    expect(text(missing).startsWith("HTTP 404 Not Found\n")).toBe(true);
  });

  it("globToRegExp handles common globs", () => {
    const m = (g: string, p: string) => tools.globToRegExp(g).test(p);
    expect(m("**/*.ts", "a.ts")).toBe(true);
    expect(m("**/*.ts", "x/y/a.ts")).toBe(true);
    expect(m("src/**", "src/a/b")).toBe(true);
    expect(m("*.ts", "x/a.ts")).toBe(false);
    expect(m("src/*.{ts,js}", "src/a.js")).toBe(true);
    expect(m("a?.[ch]", "ab.h")).toBe(true);
    expect(m("a.ts", "aXts")).toBe(false);
  });
});
