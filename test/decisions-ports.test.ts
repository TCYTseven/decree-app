/**
 * get_decisions must behave the same in every target. These tests run the runtime, the TypeScript target, the MCP
 * server, the Claude Code script and (when python3 is available) the Python target against one table of cases and
 * compare the exact output text.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Decision, GeneratedFile, HarnessSpec } from "../src/core/types.js";
import { globMatches } from "../src/decisions/glob.js";
import { runGetDecisions } from "../src/decisions/scope.js";
import { withDecisions } from "../src/decisions/tool.js";
import { generateTargets } from "../src/generators/index.js";
import { generateClaudeCode } from "../src/generators/claude-code/index.js";
import { generateMcp } from "../src/generators/mcp/index.js";
import { generatePython } from "../src/generators/python/index.js";
import { generateTypescript } from "../src/generators/typescript/index.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TMP = path.resolve("test/.tmp/decisions-ports");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };
const ROOT = "/repo";
const PYTHON = process.env.DECREE_TEST_PYTHON || "python3";
const HAS_PYTHON = spawnSync(PYTHON, ["--version"]).status === 0;

const DECISIONS: Decision[] = [
  { id: "repo", title: "Repo wide", constraint: "Repo rule.", status: "live", governs: ["**"], source: "CLAUDE.md:3" },
  { id: "src", title: "Source", constraint: "Source rule.", status: "live", governs: ["src/**"], source: "CLAUDE.md:4" },
  { id: "db", title: "Database", constraint: "Only the db layer writes SQL.", status: "live", governs: ["src/db/**", "migrations/**"], source: "docs/adr/0001-db.md", rationale: "Why." },
  { id: "users", title: "Users file", constraint: "Users rule.", status: "live", governs: ["src/db/users.ts"], source: "docs/adr/0002-users.md" },
  { id: "tsx", title: "Components", constraint: "Components rule.", status: "live", governs: ["src/**/*.{ts,tsx}"], source: ".cursor/rules/ui.mdc:5" },
  { id: "one-char", title: "One char", constraint: "One char rule.", status: "live", governs: ["lib/?.js"], source: "AGENTS.md:2" },
  { id: "draft", title: "Draft", constraint: "Draft rule.", status: "proposed", governs: ["src/db/**"], source: "AGENTS.md:9" },
  { id: "old", title: "Old", constraint: "Old rule.", status: "superseded", governs: ["src/db/**"], source: "docs/adr/0000-old.md", supersededBy: "db" },
  ...Array.from({ length: 9 }, (_, i): Decision => ({ id: `svc-${i}`, title: `Service ${i}`, constraint: `Service rule ${i}.`, status: "live", governs: [`services/api/**`], source: `services/api/AGENTS.md:${i + 1}` })),
];

const CASES: Record<string, unknown>[] = [
  { paths: ["src/db/users.ts"] },
  { paths: ["./src//db\\users.ts"] },
  { paths: ["src/db/users.ts"], include_proposed: true },
  { paths: ["src"] },
  { paths: ["src/ui/Button.tsx", "migrations/002.sql"] },
  { paths: ["lib/a.js", "lib/ab.js"] },
  { paths: ["README.md"] },
  { paths: ["."] },
  { paths: ["services/api/handler.ts"] }, // over the limit of 8
  { paths: [`${ROOT}/src/db/users.ts`] }, // absolute, inside the root
  { paths: ["/elsewhere/src/db/users.ts"] }, // absolute, outside the root
  { paths: "src/db/x.ts" },
  { paths: [] },
  { paths: [42] },
  {},
];

const GLOBS: [string, string][] = [
  ["**", "a/b"],
  ["src/**", "src"],
  ["src/*.ts", "src/a/b.ts"],
  ["src/**/*.ts", "src/a.ts"],
  ["src/?.ts", "src/ab.ts"],
  ["src/*.{ts,tsx}", "src/a.tsx"],
  ["src/db", "src/db/users.ts"],
  ["src/db/**", "src"],
  ["a.b/**", "axb/c"],
  ["src/[ab].ts", "src/a.ts"],
  ["./src//db/", "src\\db\\x.ts"],
  ["src/(x)+/**", "src/(x)+/y"],
];

const spec = (): HarnessSpec =>
  withDecisions(
    sampleSpec({
      tools: sampleSpec().tools.filter((t) => t.kind === "read_file"),
      subagents: [],
      evals: [],
      env: [{ name: "ANTHROPIC_API_KEY", description: "key", required: true, secret: true }],
      context: { caching: true, compaction: false, contextEditing: false, memory: false },
    }),
    DECISIONS,
  );

function write(dir: string, files: GeneratedFile[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
}

const expected = CASES.map((c) => runGetDecisions(DECISIONS, c, ROOT));
const expectedGlobs = GLOBS.map(([g, p]) => globMatches(g, p));

type PortModule = {
  runGetDecisions: (d: Decision[], input: Record<string, unknown>, root: string) => { output: string; isError: boolean };
  globMatches: (g: string, p: string) => boolean;
  getDecisions: (input: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>;
};

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));

describe("get_decisions agrees across targets", () => {
  it("the table has interesting cases", () => {
    expect(expected[0]!.output.indexOf("[users]")).toBeLessThan(expected[0]!.output.indexOf("[db]"));
    expect(expected[8]!.output).toContain("2 more matched but were left out (limit 8)");
    expect(expected[9]!.output).toBe(expected[0]!.output);
    expect(expected.filter((e) => e.isError)).toHaveLength(3);
  });

  it("TypeScript target", async () => {
    const dir = path.join(TMP, "typescript");
    write(dir, generateTypescript(spec(), OPTS));
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools/decisions.ts")).href)) as PortModule;
    expect(CASES.map((c) => mod.runGetDecisions(DECISIONS, c, ROOT))).toEqual(expected);
    expect(GLOBS.map(([g, p]) => mod.globMatches(g, p))).toEqual(expectedGlobs);
    // The registered tool reads decisions.json next to package.json.
    const live = await mod.getDecisions({ paths: ["src/db/users.ts"] });
    expect(live.output).toBe(runGetDecisions(DECISIONS, { paths: ["src/db/users.ts"] }).output);
  });

  it("MCP server", async () => {
    const dir = path.join(TMP, "mcp-server");
    write(dir, generateMcp(spec(), OPTS));
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/decisions.ts")).href)) as PortModule;
    expect(CASES.map((c) => mod.runGetDecisions(DECISIONS, c, ROOT))).toEqual(expected);
    expect(GLOBS.map(([g, p]) => mod.globMatches(g, p))).toEqual(expectedGlobs);
    const tools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools.ts")).href)) as {
      runTool: (name: string, input: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
    const r = await tools.runTool("get_decisions", { paths: ["src/db/users.ts"] });
    expect(r.content[0]!.text).toBe(runGetDecisions(DECISIONS, { paths: ["src/db/users.ts"] }).output);
  });

  it("Claude Code script", () => {
    const dir = path.join(TMP, "claude-code");
    write(dir, generateClaudeCode(spec(), OPTS));
    const script = path.join(dir, ".claude/skills/decisions/get-decisions.mjs");
    for (const c of CASES) {
      const paths = Array.isArray(c.paths) && c.paths.every((p) => typeof p === "string") ? (c.paths as string[]) : undefined;
      if (!paths || paths.some((p) => path.isAbsolute(p))) continue; // the script resolves absolute paths against its cwd
      const args = [script, ...(c.include_proposed ? ["--proposed"] : []), ...paths];
      const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
      const want = runGetDecisions(DECISIONS, c, dir);
      expect(r.stdout).toBe(`${want.output}\n`);
      expect(r.status).toBe(want.isError ? 1 : 0);
    }
    const abs = spawnSync(process.execPath, [script, path.join(dir, "src/db/users.ts")], { cwd: dir, encoding: "utf8" });
    expect(abs.stdout).toBe(`${expected[0]!.output}\n`);
  });

  it.skipIf(!HAS_PYTHON)("Python target", () => {
    const dir = path.join(TMP, "python");
    write(dir, generatePython(spec(), OPTS));
    const code = [
      "import json, sys",
      "from acme_ops_agent.tools import decisions as m",
      "data = json.loads(sys.stdin.read())",
      "out = [{'output': (r := m.run_get_decisions(data['decisions'], c, data['root'])).output, 'isError': r.is_error} for c in data['cases']]",
      "globs = [m.glob_matches(g, p) for g, p in data['globs']]",
      "live = m.get_decisions({'paths': ['src/db/users.ts']}, data['root']).output",
      "print(json.dumps({'out': out, 'globs': globs, 'live': live}))",
    ].join("\n");
    const r = spawnSync(PYTHON, ["-c", code], {
      cwd: dir,
      input: JSON.stringify({ decisions: DECISIONS, cases: CASES, globs: GLOBS, root: ROOT }),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(r.stderr).toBe("");
    const got = JSON.parse(r.stdout) as { out: { output: string; isError: boolean }[]; globs: boolean[]; live: string };
    expect(got.out).toEqual(expected);
    expect(got.globs).toEqual(expectedGlobs);
    expect(got.live).toBe(expected[0]!.output);
  });
});

describe("generators emit get_decisions only when the spec has decisions", () => {
  const paths = (s: HarnessSpec) => generateTargets(s, ["typescript", "python", "mcp", "claude-code"], OPTS).map((f) => f.path);

  it("adds the tool and its data file to every target", () => {
    const all = generateTargets(spec(), ["typescript", "python", "mcp", "claude-code"], OPTS);
    const byPath = Object.fromEntries(all.map((f) => [f.path, f.content]));
    for (const p of [
      "typescript/src/tools/decisions.ts",
      "typescript/decisions.json",
      "python/acme_ops_agent/tools/decisions.py",
      "python/acme_ops_agent/decisions.json",
      "mcp-server/src/decisions.ts",
      "mcp-server/decisions.json",
      "claude-code/.claude/skills/decisions/SKILL.md",
      "claude-code/.claude/skills/decisions/get-decisions.mjs",
      "claude-code/.claude/skills/decisions/decisions.json",
    ]) {
      expect(byPath[p], p).toBeDefined();
    }
    expect(JSON.parse(byPath["typescript/decisions.json"]!)).toEqual(DECISIONS);
    expect(byPath["typescript/src/tools/index.ts"]).toContain("run: getDecisions,");
    expect(byPath["python/acme_ops_agent/tools/registry.py"]).toContain('if tool.kind == "decisions":\n        return get_decisions(args, ctx.project_root)');
    expect(byPath["mcp-server/src/tools.ts"]).toContain('case "decisions"');
    expect(byPath["mcp-server/src/server.ts"]).toContain('"get_decisions"');
    expect(byPath["harness.md"]).toContain("## Decisions (17)");
    expect(byPath["README.md"]).toContain("## Decisions");
    expect(byPath["python/acme_ops_agent/tools/decisions.py"]).not.toMatch(/import fnmatch|fnmatch\./);
  });

  it("leaves decision-free specs exactly as before", () => {
    const plain = sampleSpec();
    const files = paths(plain);
    expect(files.some((p) => /decisions/.test(p))).toBe(false);
    const all = generateTargets(plain, ["typescript", "python", "mcp", "claude-code"], OPTS).map((f) => f.content).join("\n");
    expect(all).not.toContain("get_decisions");
    expect(all).not.toContain("## Decisions");
  });
});
