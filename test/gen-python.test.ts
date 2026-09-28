import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GeneratedFile, HarnessSpec, ToolSpec } from "../src/core/types.js";
import { generatePython } from "../src/generators/python/index.js";
import { pythonPackageName, pyStr, pyLiteral, toScalar, tomlStr } from "../src/generators/python/py.js";
import { withDecisions } from "../src/decisions/tool.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const TMP = path.resolve("test/.tmp/gen-python");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };
// Point DECREE_TEST_PYTHON at a venv with pytest to also run the generated tests.
const PYTHON = process.env.DECREE_TEST_PYTHON || "python3";
const HAS_PYTHON = spawnSync(PYTHON, ["--version"]).status === 0;
const HAS_PYTEST = HAS_PYTHON && spawnSync(PYTHON, ["-c", "import pytest"]).status === 0;

function render(name: string, spec: HarnessSpec): { dir: string; files: GeneratedFile[] } {
  const files = generatePython(spec, OPTS);
  const dir = path.join(TMP, name, "python");
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

function pyCompile(dir: string, files: GeneratedFile[]): void {
  const pyFiles = files.filter((f) => f.path.endsWith(".py")).map((f) => path.join(dir, f.path));
  // -W error turns invalid escape sequences (SyntaxWarning) into failures.
  const res = spawnSync(PYTHON, ["-W", "error", "-m", "py_compile", ...pyFiles], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: path.join(TMP, ".pycache") },
  });
  expect(res.stderr + res.stdout).toBe("");
  expect(res.status).toBe(0);
}

/** Run a Python snippet with the generated project on sys.path; returns parsed JSON stdout. */
function pyEval(dir: string, code: string): unknown {
  const res = spawnSync(PYTHON, ["-c", code], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

function tool(overrides: Partial<ToolSpec> & Pick<ToolSpec, "name" | "kind">): ToolSpec {
  return {
    description: `${overrides.name} tool`,
    inputSchema: { type: "object", properties: {}, required: [] },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
    ...overrides,
  };
}

const NASTY_RAW =
  'He said "hi" and \'bye\'. """triple""" \'\'\' also \\ backslash, \\n literal, C:\\path\\to\\ ' +
  "${notTemplate} {{braces}} {curly} %s \t tab \r cr \u0000 nul \u2028 ls \u2029 ps \u200b zw \u202e rlo " +
  "emoji 🚀 é 中文 \ud800 lone \x7f del\nsecond line ending in backslash \\\n\"\"\"";

function nastySpec(): HarnessSpec {
  const NASTY = NASTY_RAW;
  const base = sampleSpec();
  const fsTools = base.tools.filter((t) => ["read_file", "write_file", "list_files", "search_code"].includes(t.name));
  return sampleSpec({
    name: "123-class",
    displayName: `Nasty ${NASTY}`,
    description: NASTY,
    systemPrompt: NASTY + "\n\n" + "x".repeat(300),
    tools: [
      ...fsTools.map((t) => ({ ...t, description: `${t.description} ${NASTY}` })),
      tool({
        name: "run_nasty",
        kind: "shell",
        description: NASTY,
        inputSchema: {
          type: "object",
          properties: { [`we"ird`]: { type: "string", description: NASTY, enum: [NASTY, "b"] } },
          required: [],
        },
        shell: { command: `echo {{we"ird}} ${NASTY.replace(/\u0000/g, "")}` },
        source: NASTY,
      }),
      { ...base.tools.find((t) => t.kind === "memory")! },
    ],
    subagents: [
      {
        name: "nasty-sub",
        description: NASTY,
        systemPrompt: NASTY,
        tools: ["read_file", "does_not_exist"],
        model: 'claude-"sonnet"',
      },
    ],
    guardrails: {
      ...base.guardrails,
      blockedCommands: [NASTY, "rm -rf /"],
      redactEnv: ["A\"B"],
      maxCostUsd: undefined,
    },
    evals: [{ id: NASTY, input: NASTY, expect: { contains: [NASTY], rubric: NASTY } }],
    env: [{ name: "ANTHROPIC_API_KEY", description: NASTY, required: true, secret: true }],
  });
}

describe("python generator helpers", () => {
  it("pyStr produces literals Python reads back exactly", () => {
    expect(pyStr('a"b')).toBe('"a\\"b"');
    expect(pyStr("\u2028")).toBe('"\\u2028"');
    expect(pyStr("\x7f")).toBe('"\\u007f"');
    expect(pyStr("a\ud800b\ud83d\ude80")).toBe('"a\\ufffdb\ud83d\ude80"');
    expect(pyLiteral({ a: [true, null, 1.5, "x"], b: {}, c: [{ d: 1 }] })).toBe(
      '{\n    "a": [True, None, 1.5, "x"],\n    "b": {},\n    "c": [\n        {\n            "d": 1,\n        },\n    ],\n}',
    );
    expect(tomlStr("\ud800x")).toBe('"\\ufffdx"');
  });

  it("derives valid, non-shadowing package names", () => {
    expect(pythonPackageName("acme-ops-agent")).toBe("acme_ops_agent");
    expect(pythonPackageName("123-class")).toBe("agent_123_class");
    expect(pythonPackageName("class")).toBe("agent_class");
    expect(pythonPackageName("anthropic")).toBe("agent_anthropic");
    expect(pythonPackageName("My App!!")).toBe("my_app");
    expect(pythonPackageName("---")).toBe("agent");
  });
});

describe("generatePython", () => {
  it("renders the full project for the sample spec", () => {
    const { dir, files } = render("sample", sampleSpec());
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".env.example",
        "README.md",
        "acme_ops_agent/__init__.py",
        "acme_ops_agent/__main__.py",
        "acme_ops_agent/agent.py",
        "acme_ops_agent/cli.py",
        "acme_ops_agent/config.py",
        "acme_ops_agent/dotenv.py",
        "acme_ops_agent/evals.py",
        "acme_ops_agent/prompt.py",
        "acme_ops_agent/subagents.py",
        "acme_ops_agent/tools/__init__.py",
        "acme_ops_agent/tools/base.py",
        "acme_ops_agent/tools/fs.py",
        "acme_ops_agent/tools/http.py",
        "acme_ops_agent/tools/memory.py",
        "acme_ops_agent/tools/registry.py",
        "acme_ops_agent/tools/shell.py",
        "pyproject.toml",
        "tests/test_tools.py",
      ].sort(),
    );
    const f = byPath(files);
    expect(f["pyproject.toml"]).toContain('requires-python = ">=3.10"');
    expect(f["pyproject.toml"]).toMatch(/"anthropic>=1\.\d+"/);
    expect(f["pyproject.toml"]).toContain('"httpx>=');
    expect(f["pyproject.toml"]).toContain('"acme-ops-agent" = "acme_ops_agent.cli:main"');
    const agent = f["acme_ops_agent/agent.py"];
    expect(agent).toContain("get_final_message()");
    expect(agent).toContain('{"type": "adaptive"}');
    expect(agent).toContain('"output_config": {"effort": self.effort}');
    expect(agent).toContain("ThreadPoolExecutor");
    expect(agent).toContain('"pause_turn"');
    expect(agent).toContain('"refusal"');
    expect(agent).toContain('"max_tokens"');
    expect(agent).toContain("self._delegate(");
    const config = f["acme_ops_agent/config.py"];
    expect(config).toContain("COMPACTION: bool = True");
    expect(config).toContain('MODEL: str = os.environ.get("ACME_OPS_AGENT_MODEL") or "claude-opus-5"');
    expect(config).toContain("MAX_COST_USD: float | None = 5.0");
    const registry = f["acme_ops_agent/tools/registry.py"];
    expect(registry.indexOf('name="list_orders"')).toBeLessThan(registry.indexOf('name="memory"'));
    expect(registry).toContain('"web_search_20260209"');
    expect(registry).toContain('"memory_20250818"');
    expect(f["README.md"]).toContain("| `cancel_order` | http |");
    expect(f[".env.example"]).toContain("ACME_BASE_URL=http://localhost:3000");
    expect(f[".env.example"]).toMatch(/^ACME_API_TOKEN=$/m);
    for (const file of files) expect(file.path.startsWith("/")).toBe(false);
    if (HAS_PYTHON) pyCompile(dir, files);
  });

  it("is deterministic", () => {
    const a = generatePython(sampleSpec(), OPTS);
    const b = generatePython(sampleSpec(), OPTS);
    expect(b).toEqual(a);
    const n1 = generatePython(nastySpec(), OPTS);
    const n2 = generatePython(nastySpec(), OPTS);
    expect(n2).toEqual(n1);
  });

  it("omits subagents when there are none", () => {
    const { dir, files } = render("no-subagents", sampleSpec({ subagents: [] }));
    const f = byPath(files);
    expect(f["acme_ops_agent/subagents.py"]).toBeUndefined();
    expect(f["acme_ops_agent/agent.py"]).not.toContain("SubagentDef");
    expect(f["acme_ops_agent/agent.py"]).not.toContain("_delegate");
    expect(f["acme_ops_agent/prompt.py"]).not.toContain("SUBAGENT_PROMPTS");
    if (HAS_PYTHON) pyCompile(dir, files);
  });

  it("omits http (and the httpx dependency) when there are no http tools", () => {
    const spec = sampleSpec();
    const { dir, files } = render("no-http", sampleSpec({ tools: spec.tools.filter((t) => t.kind !== "http") }));
    const f = byPath(files);
    expect(f["acme_ops_agent/tools/http.py"]).toBeUndefined();
    expect(f["pyproject.toml"]).not.toContain("httpx");
    expect(f["acme_ops_agent/tools/registry.py"]).not.toContain("call_http");
    if (HAS_PYTHON) pyCompile(dir, files);
  });

  it("renders an fs-only harness", () => {
    const spec = sampleSpec();
    const fsOnly = sampleSpec({
      tools: spec.tools.filter((t) => ["read_file", "write_file", "list_files", "search"].includes(t.kind)),
      subagents: [],
      evals: [],
      context: { caching: false, compaction: false, contextEditing: true, memory: false },
      model: { ...spec.model, thinking: "off" },
    });
    const { dir, files } = render("fs-only", fsOnly);
    const f = byPath(files);
    for (const mod of ["http", "shell", "memory"]) expect(f[`acme_ops_agent/tools/${mod}.py`]).toBeUndefined();
    expect(f["acme_ops_agent/tools/fs.py"]).toBeDefined();
    expect(f["acme_ops_agent/config.py"]).toContain("ADAPTIVE_THINKING: bool = False");
    expect(f["acme_ops_agent/config.py"]).toContain("CONTEXT_EDITING: bool = True");
    expect(f["acme_ops_agent/evals.py"]).toContain("EVAL_CASES: list[dict[str, Any]] = []");
    if (HAS_PYTHON) pyCompile(dir, files);
    if (HAS_PYTEST) {
      // fs-only needs neither anthropic nor httpx, so the generated tests run with a bare pytest.
      const res = spawnSync(PYTHON, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    }
  });

  it("renders get_decisions with its data file, and its generated tests pass", () => {
    const spec = sampleSpec();
    const withD = withDecisions(
      sampleSpec({ tools: spec.tools.filter((t) => ["read_file", "list_files"].includes(t.kind)), subagents: [], evals: [] }),
      [{ id: "adr-0001-db", title: "Database", constraint: "Only src/db writes SQL.", status: "live", governs: ["src/db/**"], source: "docs/adr/0001-db.md" }],
    );
    const { dir, files } = render("decisions", withD);
    const f = byPath(files);
    expect(f["acme_ops_agent/tools/decisions.py"]).toContain("def run_get_decisions(");
    expect(JSON.parse(f["acme_ops_agent/decisions.json"]!)).toEqual(withD.decisions);
    expect(f["acme_ops_agent/tools/registry.py"]).toContain('kind="decisions"');
    expect(f["README.md"]).toContain("acme_ops_agent/decisions.json");
    if (HAS_PYTHON) pyCompile(dir, files);
    if (HAS_PYTEST) {
      const res = spawnSync(PYTHON, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    }
  });

  it("adds a memory tool when context.memory is on but no memory tool is listed", () => {
    const spec = sampleSpec();
    const files = byPath(
      generatePython(sampleSpec({ tools: spec.tools.filter((t) => t.kind !== "memory") }), OPTS),
    );
    expect(files["acme_ops_agent/tools/memory.py"]).toBeDefined();
    expect(files["acme_ops_agent/tools/registry.py"]).toContain('kind="memory"');
  });

  it.skipIf(!HAS_PYTHON)("escapes hostile strings so Python reads them back verbatim", () => {
    // Lone surrogates are the one deliberate change: they become U+FFFD.
    const spec: HarnessSpec = JSON.parse(
      JSON.stringify(nastySpec(), (_k, v: unknown) => (typeof v === "string" ? toScalar(v) : v)),
    );
    const NASTY = toScalar(NASTY_RAW);
    const { dir, files } = render("nasty", nastySpec());
    const f = byPath(files);
    expect(f["agent_123_class/__init__.py"]).toBeDefined();
    pyCompile(dir, files);

    const out = pyEval(
      dir,
      [
        "import json",
        "from agent_123_class import config, prompt",
        "from agent_123_class.tools import registry",
        "from agent_123_class import subagents, evals",
        "print(json.dumps({",
        "  'system': prompt.SYSTEM_PROMPT,",
        "  'description': config.DESCRIPTION,",
        "  'display': config.DISPLAY_NAME,",
        "  'blocked': list(config.BLOCKED_COMMANDS),",
        "  'redact': list(config.REDACT_ENV),",
        "  'max_cost': config.MAX_COST_USD,",
        "  'tools': [[t.name, t.description, t.input_schema, t.binding, t.source] for t in registry.TOOLS],",
        "  'sub': [[s.description, s.system_prompt, list(s.tools), s.model] for s in subagents.SUBAGENTS],",
        "  'evals': evals.EVAL_CASES,",
        "}))",
      ].join("\n"),
    ) as Record<string, any>;

    expect(out.system).toBe(spec.systemPrompt);
    expect(out.description).toBe(spec.description);
    expect(out.display).toBe(spec.displayName);
    expect(out.blocked).toEqual(spec.guardrails.blockedCommands);
    expect(out.redact).toEqual(spec.guardrails.redactEnv);
    expect(out.max_cost).toBeNull();
    const shellTool = spec.tools.find((t) => t.name === "run_nasty")!;
    const shellOut = out.tools.find((t: any[]) => t[0] === "run_nasty");
    expect(shellOut[1]).toBe(shellTool.description);
    expect(shellOut[2]).toEqual(shellTool.inputSchema);
    expect(shellOut[3]).toEqual(shellTool.shell);
    expect(shellOut[4]).toBe(NASTY);
    for (const t of spec.tools) {
      if (t.kind === "memory") continue;
      expect(out.tools.find((o: any[]) => o[0] === t.name)[1]).toBe(t.description);
    }
    expect(out.sub).toEqual([[NASTY, NASTY, ["read_file"], 'claude-"sonnet"']]);
    expect(out.evals).toEqual([{ id: NASTY, input: NASTY, expect: { contains: [NASTY], rubric: NASTY } }]);

    // Nothing hostile leaks into comments/docstrings: every docstring line is plain text.
    for (const file of files.filter((x) => x.path.endsWith(".py"))) {
      expect(file.content).not.toContain("\u2028");
      expect(file.content).not.toContain("\u202e");
    }
    // pyproject.toml stays valid TOML (Python 3.11+ ships tomllib).
    const toml = spawnSync(PYTHON, ["-c", "import sys, tomllib; tomllib.load(open(sys.argv[1], 'rb'))", path.join(dir, "pyproject.toml")], {
      encoding: "utf8",
    });
    if (!toml.stderr.includes("No module named 'tomllib'")) expect(toml.status, toml.stderr).toBe(0);
  });
});

describe("generated Python passes a default linter (QA regression)", () => {
  const HAS_RUFF = spawnSync("ruff", ["--version"]).status === 0;
  it("has no lambda assignments (ruff E731) and skips virtualenvs in fs tools", () => {
    const files = byPath(generatePython(sampleSpec(), { outDir: "agent", decreeVersion: "x" }));
    for (const [p, c] of Object.entries(files)) if (p.endsWith(".py")) expect(c, p).not.toMatch(/^\s*\w+ = \(?lambda\b/m);
    expect(files["acme_ops_agent/config.py"]).toMatch(/IGNORED_DIRS = frozenset\(\{[^}]*"\.venv"/);
  });
  it.skipIf(!HAS_RUFF)("ruff check --isolated finds nothing (the user's own `ruff check .` sees agent/python)", () => {
    const { dir } = render("ruff", sampleSpec());
    const r = spawnSync("ruff", ["check", "--isolated", "--no-cache", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toMatch(/All checks passed/);
  });
});
