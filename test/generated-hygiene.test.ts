// Regression tests, runtime AND every generated target:
//  1. decree-private `x-*` schema keywords never reach the Anthropic API,
//  2. list_files / search skip directories holding the `.decree-generated` marker (and so does the scanner),
//  3. read_file redacts before truncating, so a secret at the byte limit leaves no fragment.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { stripPrivateKeywords } from "../src/core/json-schema.js";
import { GENERATED_MARKER } from "../src/core/markers.js";
import type { HarnessSpec, ToolSpec } from "../src/core/types.js";
import { generateCommon } from "../src/generators/common/index.js";
import { generateMcp } from "../src/generators/mcp/index.js";
import { generatePython } from "../src/generators/python/index.js";
import { generateTypescript } from "../src/generators/typescript/index.js";
import { runAgentWithClient } from "../src/runtime/index.js";
import { executeTool, type ToolContext } from "../src/runtime/tools/index.js";
import { walkProject } from "../src/scanner/walk.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TMP = path.resolve("test/.tmp/hygiene");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };
const PROJECT = path.join(TMP, "project");
const SECRET = "hygiene-secret-VALUE-0123456789";
const MAX = 100;
const WIDE = 30_000;

// ---------------------------------------------------------------------------
// Spec + project fixture
// ---------------------------------------------------------------------------

/** sampleSpec plus a shell tool with `x-` keywords (top level and nested), a header property named `x-request-id`, and a small read limit. */
function hygieneSpec(): HarnessSpec {
  const base = sampleSpec();
  const tools: ToolSpec[] = base.tools.map((t) => (t.kind === "read_file" ? { ...t, fs: { root: ".", maxBytes: MAX } } : t));
  const reader = base.tools.find((t) => t.kind === "read_file")!;
  tools.push({ ...reader, name: "read_wide", fs: { root: ".", maxBytes: WIDE } });
  tools.push({
    name: "grep_flags",
    description: "grep with flags",
    kind: "shell",
    inputSchema: {
      type: "object",
      "x-decree-note": "top-level private keyword",
      properties: {
        flags: { type: "string", description: "grep flags", "x-allow-flags": true },
        opts: { type: "object", "x-json-string": true, properties: { deep: { type: "array", items: { type: "string", "x-inner": 1 } } } },
        term: { type: "string", enum: ["x-literal-value"] },
      },
      required: ["flags"],
    },
    shell: { command: "echo {{flags}}", cwd: "." },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
  });
  tools.push({
    name: "traced_get",
    description: "GET with a request id header",
    kind: "http",
    inputSchema: { type: "object", properties: { "x-request-id": { type: "string", description: "Trace id" } }, required: [] },
    http: { method: "GET", baseUrlEnv: "HYGIENE_BASE", defaultBaseUrl: "http://127.0.0.1:9", path: "/t", headerParams: ["x-request-id"] },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
  });
  return { ...base, tools, guardrails: { ...base.guardrails, redactEnv: [...base.guardrails.redactEnv, "HYGIENE_SECRET"] } };
}

/** Every `x-` keyword in a schema-ish value (property names under `properties` and enum data are not keywords). */
function privateKeywords(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => privateKeywords(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith("x-")) out.push(`${at}.${k}`);
    if (k === "enum" || k === "required") continue;
    if (k === "properties" && v && typeof v === "object") {
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) out.push(...privateKeywords(sub, `${at}.properties.${name}`));
    } else out.push(...privateKeywords(v, `${at}.${k}`));
  }
  return out;
}

function expectNoPrivateKeywords(defs: { name?: string; input_schema?: unknown }[]): void {
  const grep = defs.find((d) => d.name === "grep_flags");
  expect(grep, "grep_flags definition").toBeDefined();
  expect(defs.flatMap((d) => privateKeywords(d.input_schema, String(d.name)))).toEqual([]);
  // The shell tool keeps its shape; a property that merely has an x- name survives.
  const props = (grep!.input_schema as { properties: Record<string, Record<string, unknown>> }).properties;
  expect(props.flags).toEqual({ type: "string", description: "grep flags" });
  expect(props.term!.enum).toEqual(["x-literal-value"]);
  const traced = defs.find((d) => d.name === "traced_get")!;
  expect(Object.keys((traced.input_schema as { properties: object }).properties)).toEqual(["x-request-id"]);
}

/**
 * <PROJECT>/
 *   src/app.ts                     "needle" (listed + searched)
 *   agent/.decree-generated        marker -> whole agent/ tree skipped
 *   agent/typescript/src/x.ts      "needle"
 *   pkg/out/.decree-generated      nested marker -> pkg/out skipped, pkg/keep.ts kept
 *   big.txt                        MAX-8 filler bytes, then SECRET straddling the limit
 *   huge.txt                       > MAX + 4096 bytes, SECRET straddling the read margin
 *   shrink.txt                     1000 x SECRET (redaction shrinks them), then a SECRET cut off by the end of
 *                                  what read_wide reads (WIDE + 4096): shrinking pulls it under the limit, so
 *                                  only the always-cut margin keeps its fragment out
 */
function makeProject(): void {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  const w = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(PROJECT, rel)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, rel), content);
  };
  w("src/app.ts", "const needle = 1;\n");
  w("pkg/keep.ts", "export const needle = 2;\n");
  w("pkg/out/gen.ts", "export const needle = 3;\n");
  w(`pkg/out/${GENERATED_MARKER}`, "generated\n");
  for (const f of generateCommon(sampleSpec(), OPTS)) w(`agent/${f.path}`, f.content);
  w("agent/typescript/src/x.ts", "const needle = 4;\n");
  w("big.txt", "a".repeat(MAX - 8) + SECRET + " tail\n");
  // Redaction shrinks nothing here; the secret starts 10 bytes before the end of what read_file reads.
  w("huge.txt", "b".repeat(MAX + 4096 - 10) + SECRET + "c".repeat(5000));
  const head = SECRET.repeat(1000);
  w("shrink.txt", head + "b".repeat(WIDE + 4096 - 10 - head.length) + SECRET + "c".repeat(5000));
}

const LISTED = ["big.txt", "huge.txt", "pkg/keep.ts", "shrink.txt", "src/app.ts"];
const SEARCHED = ["pkg/keep.ts:1", "src/app.ts:1"];

/** No prefix of SECRET (5+ chars) appears in `text`. */
function expectNoFragment(text: string): void {
  for (let n = 5; n <= SECRET.length; n++) expect(text, `fragment ${SECRET.slice(0, n)}`).not.toContain(SECRET.slice(0, n));
}

function expectShrinkSafe(text: string): void {
  expect(text.startsWith("[REDACTED:HYGIENE_SECRET]".repeat(3))).toBe(true);
  expect(text).toMatch(/…\[truncated \d+ bytes\]$/);
  expectNoFragment(text);
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  makeProject();
  process.env.HYGIENE_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.HYGIENE_SECRET;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function renderTo(dir: string, files: { path: string; content: string }[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

describe("stripPrivateKeywords", () => {
  it("drops x- keywords at any depth but keeps property names, enum/const/default data, and the input", () => {
    const schema = {
      type: "object",
      "x-a": 1,
      properties: { "x-name": { type: "string", "x-b": true }, n: { anyOf: [{ type: "string", "x-c": 1 }], default: { "x-d": 1 } } },
      $defs: { "x-def": { type: "number", "x-e": 1 } },
    };
    const copy = JSON.parse(JSON.stringify(schema));
    expect(stripPrivateKeywords(schema)).toEqual({
      type: "object",
      properties: { "x-name": { type: "string" }, n: { anyOf: [{ type: "string" }], default: { "x-d": 1 } } },
      $defs: { "x-def": { type: "number" } },
    });
    expect(schema).toEqual(copy);
  });

  it("generateCommon writes the .decree-generated marker at the output root", () => {
    const marker = generateCommon(sampleSpec(), OPTS).find((f) => f.path === GENERATED_MARKER);
    expect(marker?.content).toMatch(/decree-harness/);
    expect(marker?.content).toMatch(/list_files/);
  });

  it("the scanner skips directories holding the marker (no manifest needed)", async () => {
    const { files, dirs } = await walkProject(PROJECT, 1000);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(expect.arrayContaining(["src/app.ts", "pkg/keep.ts"]));
    expect(paths.filter((p) => p.startsWith("agent/") || p.startsWith("pkg/out/"))).toEqual([]);
    expect(dirs).not.toContain("agent");
    expect(dirs).not.toContain("pkg/out");
  });
});

// ---------------------------------------------------------------------------
// Built-in runtime
// ---------------------------------------------------------------------------

describe("built-in runtime", () => {
  const spec = hygieneSpec();
  const tool = (name: string) => spec.tools.find((t) => t.name === name)!;
  const ctx = (): ToolContext => ({ projectRoot: PROJECT, spec });

  it("sends tool definitions without x- keywords (captured request)", async () => {
    const bodies: any[] = [];
    const stream = (body: any) => {
      bodies.push(JSON.parse(JSON.stringify(body)));
      return {
        on() {
          return this;
        },
        finalMessage: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
      };
    };
    const client = { messages: { stream }, beta: { messages: { stream } } };
    await runAgentWithClient(spec, { projectRoot: PROJECT, prompt: "hi" }, client);
    expect(bodies).toHaveLength(1);
    expectNoPrivateKeywords(bodies[0].tools);
    // ...while the local shell still honors x-allow-flags from decree.json.
    expect(await executeTool(tool("grep_flags"), { flags: "-x" }, ctx())).toEqual({ output: "exit code: 0\n-x\n", isError: false });
  });

  it("list_files and search skip generated directories", async () => {
    const listed = await executeTool(tool("list_files"), { pattern: "**/*" }, ctx());
    expect(listed.output.split("\n")).toEqual(LISTED);
    const inside = await executeTool(tool("list_files"), { pattern: "agent/**" }, ctx());
    expect(inside.output).toMatch(/^No files match/);
    const found = await executeTool(tool("search_code"), { query: "needle" }, ctx());
    expect(found.output.split("\n").map((l) => l.split(":").slice(0, 2).join(":"))).toEqual(SEARCHED);
  });

  it("read_file redacts before truncating", async () => {
    const big = await executeTool(tool("read_file"), { path: "big.txt" }, ctx());
    expect(big.output).toMatch(/^a{92}\[REDACTE/);
    expect(big.output).toMatch(/…\[truncated \d+ bytes\]$/);
    expectNoFragment(big.output);
    const huge = await executeTool(tool("read_file"), { path: "huge.txt" }, ctx());
    expect(huge.output.startsWith("b".repeat(MAX))).toBe(true);
    expectNoFragment(huge.output);
    expectShrinkSafe((await executeTool(tool("read_wide"), { path: "shrink.txt" }, ctx())).output);
  });
});

// ---------------------------------------------------------------------------
// Generated TypeScript
// ---------------------------------------------------------------------------

type TsResult = { output: string; isError: boolean };
type TsEntry = { definition: { name: string; input_schema?: unknown }; run?: (i: Record<string, unknown>) => Promise<TsResult> };

describe("generated TypeScript", () => {
  const dir = path.join(TMP, "ts", "typescript");
  let TOOLS: TsEntry[] = [];
  beforeAll(async () => {
    renderTo(dir, generateTypescript(hygieneSpec(), OPTS));
    process.env.PROJECT_ROOT = PROJECT;
    ({ TOOLS } = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools/index.ts")).href)) as { TOOLS: TsEntry[] });
  });
  afterAll(() => delete process.env.PROJECT_ROOT);
  const run = (name: string, input: Record<string, unknown>) => TOOLS.find((t) => t.definition.name === name)!.run!(input);

  it("the tool registry sends no x- keywords; the shell binding keeps allowFlags", async () => {
    expectNoPrivateKeywords(TOOLS.map((t) => t.definition));
    expect(await run("grep_flags", { flags: "-x" })).toEqual({ output: "exit code: 0\n-x\n", isError: false });
  });

  it("list_files and search skip generated directories", async () => {
    expect((await run("list_files", { pattern: "**/*" })).output.split("\n")).toEqual(LISTED);
    const found = (await run("search_code", { query: "needle" })).output;
    expect(found.split("\n").map((l) => l.split(":").slice(0, 2).join(":"))).toEqual(SEARCHED);
  });

  it("read_file redacts before truncating", async () => {
    const big = await run("read_file", { path: "big.txt" });
    expect(big.output).toMatch(/^a{92}\[REDACTE/);
    expect(big.output).toMatch(/…\[truncated \d+ bytes\]$/);
    expectNoFragment(big.output);
    const huge = await run("read_file", { path: "huge.txt" });
    expect(huge.output.startsWith("b".repeat(MAX))).toBe(true);
    expectNoFragment(huge.output);
    expectShrinkSafe((await run("read_wide", { path: "shrink.txt" })).output);
  });
});

// ---------------------------------------------------------------------------
// Generated MCP server
// ---------------------------------------------------------------------------

describe("generated MCP server", () => {
  const dir = path.join(TMP, "mcp", "mcp-server");
  type McpTools = {
    INPUT_SCHEMAS: Record<string, z.ZodType>;
    runTool(name: string, input: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }>;
  };
  let tools: McpTools;
  beforeAll(async () => {
    renderTo(dir, generateMcp(hygieneSpec(), OPTS));
    process.env.DECREE_PROJECT_ROOT = PROJECT;
    tools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools.ts")).href)) as McpTools;
  });
  afterAll(() => delete process.env.DECREE_PROJECT_ROOT);
  const text = async (name: string, input: Record<string, unknown>) => (await tools.runTool(name, input)).content[0]!.text;

  it("the published JSON schemas carry no x- keywords; the shell binding keeps allowFlags", async () => {
    const defs = Object.entries(tools.INPUT_SCHEMAS).map(([name, schema]) => ({ name, input_schema: z.toJSONSchema(schema, { io: "input" }) }));
    expectNoPrivateKeywords(defs.map((d) => ({ ...d, input_schema: { ...(d.input_schema as object), $schema: undefined } })));
    expect(await text("grep_flags", { flags: "-x" })).toBe("exit code: 0\n-x\n");
  });

  it("list_files and search skip generated directories", async () => {
    expect((await text("list_files", { pattern: "**/*" })).split("\n")).toEqual(LISTED);
    const found = await text("search_code", { query: "needle" });
    expect(found.split("\n").map((l) => l.split(":").slice(0, 2).join(":"))).toEqual(SEARCHED);
  });

  it("read_file redacts before truncating", async () => {
    const big = await text("read_file", { path: "big.txt" });
    expect(big).toMatch(/^a{92}\[REDACTE/);
    expect(big).toMatch(/…\[truncated \d+ bytes\]$/);
    expectNoFragment(big);
    const huge = await text("read_file", { path: "huge.txt" });
    expect(huge.startsWith("b".repeat(MAX))).toBe(true);
    expectNoFragment(huge);
    expectShrinkSafe(await text("read_wide", { path: "shrink.txt" }));
  });
});

// ---------------------------------------------------------------------------
// Generated Python
// ---------------------------------------------------------------------------

const HAS_PYTHON = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!HAS_PYTHON)("generated Python", () => {
  const dir = path.join(TMP, "py", "python");
  const stubs = path.join(TMP, "py", "stubs");
  let pkg = "";
  beforeAll(() => {
    const files = generatePython(hygieneSpec(), OPTS);
    renderTo(dir, files);
    pkg = files.find((f) => f.path.endsWith("/tools/registry.py"))!.path.split("/")[0]!;
    fs.mkdirSync(stubs, { recursive: true });
    // Minimal stubs so the package imports without its real dependencies.
    fs.writeFileSync(path.join(stubs, "httpx.py"), "class HTTPError(Exception):\n    pass\n\ndef request(**kw):\n    raise HTTPError('stub')\n");
    fs.writeFileSync(path.join(stubs, "anthropic.py"), "class Anthropic:\n    pass\n");
  });

  /** Run `code` with the registry imported as `reg` and the project root as `root`; returns parsed JSON stdout. */
  function py(code: string): any {
    const prelude = ["import json", "from pathlib import Path", `from ${pkg}.tools import registry as reg`, `root = Path(${JSON.stringify(PROJECT)})`];
    const res = spawnSync("python3", ["-c", [...prelude, code].join("\n")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: `${dir}${path.delimiter}${stubs}`, PYTHONDONTWRITEBYTECODE: "1", HYGIENE_SECRET: SECRET },
    });
    if (res.status !== 0) throw new Error(res.stderr);
    return JSON.parse(res.stdout);
  }
  const call = (name: string, args: Record<string, unknown>) =>
    `reg.execute_tool(reg.TOOLS_BY_NAME[${JSON.stringify(name)}], json.loads(${JSON.stringify(JSON.stringify(args))}), reg.ToolContext(project_root=root))`;

  it("api_tool_params sends no x- keywords; the shell binding keeps allowFlags", () => {
    const out = py(`r = ${call("grep_flags", { flags: "-x" })}\nprint(json.dumps({"defs": reg.api_tool_params(), "shell": [r.output, r.is_error]}))`);
    expectNoPrivateKeywords(out.defs);
    expect(out.shell).toEqual(["exit code: 0\n-x\n", false]);
  });

  it("list_files and search skip generated directories", () => {
    const out = py(`print(json.dumps([${call("list_files", { pattern: "**/*" })}.output, ${call("search_code", { query: "needle" })}.output]))`);
    expect(out[0].split("\n").sort()).toEqual(LISTED); // os.walk order: files before subdirectories
    expect(out[1].split("\n").map((l: string) => l.split(":").slice(0, 2).join(":"))).toEqual(SEARCHED);
  });

  it("read_file redacts before truncating", () => {
    const [big, huge, shrink] = py(
      `print(json.dumps([${call("read_file", { path: "big.txt" })}.output, ${call("read_file", { path: "huge.txt" })}.output, ${call("read_wide", { path: "shrink.txt" })}.output]))`,
    );
    expect(big).toMatch(/^a{92}\[REDACTE/);
    expect(big).toMatch(/…\[truncated \d+ bytes\]$/);
    expectNoFragment(big);
    expect(huge.startsWith("b".repeat(MAX))).toBe(true);
    expectNoFragment(huge);
    expectShrinkSafe(shrink);
  });
});
