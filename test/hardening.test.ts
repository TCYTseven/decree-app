// Regression tests for the security hardening pass: shell template quoting, option
// injection, secret masking in scanner excerpts, Claude Code permission breadth,
// redact-before-truncate, same-origin redirects, memory symlinks, loop history.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskSecrets } from "../src/core/mask-secrets.js";
import { normalizeShellTemplate, unsafeTemplateError } from "../src/core/shell-template.js";
import { saveProfile } from "../src/core/config.js";
import { validateSpec } from "../src/core/spec.js";
import type { HarnessSpec, ToolSpec } from "../src/core/types.js";
import { derivePermissions } from "../src/generators/claude-code/mapping.js";
import { generateMcp } from "../src/generators/mcp/index.js";
import { generatePython } from "../src/generators/python/index.js";
import { generateTypescript } from "../src/generators/typescript/index.js";
import { renderProfileDigest } from "../src/planner/digest.js";
import { executeHttp, executeShell, renderShellCommand, type ToolContext } from "../src/runtime/tools/index.js";
import { scanProject } from "../src/scanner/index.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

const TMP = path.resolve("test/.tmp/hardening");
const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SECRET = "hardening-secret-value-TAIL9";

function shellTool(name: string, command: string, props: Record<string, Record<string, unknown>> = {}): ToolSpec {
  return {
    name,
    description: name,
    kind: "shell",
    inputSchema: { type: "object", properties: props, required: [] },
    shell: { command, cwd: "." },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
  };
}

function httpTool(name: string, p: string): ToolSpec {
  return {
    name,
    description: name,
    kind: "http",
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method: "GET", baseUrlEnv: "HARDEN_BASE", path: p, auth: { type: "header", env: "HARDEN_KEY", header: "x-api-key" } },
    readOnly: true,
    destructive: false,
    requiresApproval: false,
  };
}

/** sampleSpec plus tools that exercise the hardening (bypassing validateSpec on purpose). */
function hardeningSpec(): HarnessSpec {
  const base = sampleSpec();
  return {
    ...base,
    tools: [
      ...base.tools,
      shellTool("echo_msg", "echo {{msg}}", { msg: { type: "string" } }),
      shellTool("echo_flag", "echo {{flag}}", { flag: { type: "string", "x-allow-flags": true } }),
      shellTool("quoted_tpl", 'echo "hi {{msg}}"', { msg: { type: "string" } }),
      shellTool("leak_tail", `printf '%s' "$HARDEN_SECRET"; head -c 29995 /dev/zero | tr '\\0' x`),
      httpTool("redir_cross", "/cross"),
      httpTool("redir_same", "/same"),
    ],
    guardrails: { ...base.guardrails, redactEnv: [...base.guardrails.redactEnv, "HARDEN_SECRET", "HARDEN_SHORT"] },
  };
}

function renderTo(dir: string, files: { path: string; content: string }[]): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
}

// ---------------------------------------------------------------------------
// A two-origin HTTP fixture: /cross redirects to another origin, /same stays.
// ---------------------------------------------------------------------------

let originA = "";
let originB = "";
const seenByB: http.IncomingHttpHeaders[] = [];
const servers: http.Server[] = [];

beforeAll(async () => {
  const listen = (handler: http.RequestListener) =>
    new Promise<string>((resolve) => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });
  originB = await listen((req, res) => {
    seenByB.push(req.headers);
    res.end("other origin");
  });
  originA = await listen((req, res) => {
    if (req.url === "/cross") res.writeHead(302, { location: `${originB}/steal` }).end();
    else if (req.url === "/same") res.writeHead(302, { location: "/final" }).end();
    else if (req.url === "/final") res.end(`final key=${req.headers["x-api-key"] ?? "none"} leak=${SECRET}`);
    else res.writeHead(404).end();
  });
  process.env.HARDEN_BASE = originA;
  process.env.HARDEN_KEY = "k-hardening-key";
  process.env.HARDEN_SECRET = SECRET;
  process.env.HARDEN_SHORT = "abc";
});

afterAll(() => {
  for (const s of servers) s.close();
  for (const k of ["HARDEN_BASE", "HARDEN_KEY", "HARDEN_SECRET", "HARDEN_SHORT"]) delete process.env[k];
});

// ---------------------------------------------------------------------------
// 1. Placeholders inside quotes
// ---------------------------------------------------------------------------

describe("shell templates: placeholders must be bare words", () => {
  it("scanner flags quoted / substitution contexts and normalizes quotes that wrap exactly one placeholder", () => {
    expect(normalizeShellTemplate('grep -rn "{{pattern}}" src')).toMatchObject({ command: "grep -rn {{pattern}} src", unsafe: [] });
    expect(normalizeShellTemplate("echo '{{x}}' {{y}}")).toMatchObject({ command: "echo {{x}} {{y}}", unsafe: [] });
    expect(normalizeShellTemplate("git log --grep={{p}}").unsafe).toEqual([]);
    for (const bad of ['echo "a {{x}}"', "echo 'a {{x}}'", "echo `{{x}}`", "echo $({{x}})", "echo ${{x}}", "echo \\{{x}}", "echo ${V:-{{x}}}", "echo hi # {{x}}"]) {
      expect(unsafeTemplateError(bad), bad).toMatch(/unsafe command template/);
      expect(normalizeShellTemplate(bad).unsafe.length, bad).toBeGreaterThan(0);
    }
    expect(unsafeTemplateError("npm test -- {{pattern}}")).toBeUndefined();
  });

  it("validateSpec normalizes trivially quoted placeholders and rejects the rest", () => {
    const base = sampleSpec();
    const withCmd = (command: string) => ({ ...base, tools: [shellTool("grep_code", command, { pattern: { type: "string" } })], subagents: [], evals: [] });
    const ok = validateSpec(withCmd('grep -rn "{{pattern}}" src'));
    if (!ok.ok) throw new Error(ok.errors.join("\n"));
    expect(ok.spec.tools[0]!.shell!.command).toBe("grep -rn {{pattern}} src");
    expect(ok.warnings.join("\n")).toMatch(/bare words/);
    const bad = validateSpec(withCmd('grep -rn "x{{pattern}}" src'));
    if (bad.ok) throw new Error("expected the quoted placeholder to be rejected");
    expect(bad.errors.join("\n")).toMatch(/tools\[0\]\.shell\.command: placeholder \{\{pattern\}\} is inside double quotes/);
  });

  it("the runtime refuses to render an unsafe template (defense in depth)", async () => {
    expect(() => renderShellCommand('echo "{{x}}"', { x: "$(id)" })).toThrow(/unsafe command template/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "decree-harden-"));
    try {
      const ctx: ToolContext = { projectRoot: root, spec: sampleSpec() };
      const res = await executeShell(shellTool("q", 'echo "{{msg}}"'), { msg: '"; touch pwned; "' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.output).toMatch(/unsafe command template/);
      expect(fs.existsSync(path.join(root, "pwned"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Option injection
// ---------------------------------------------------------------------------

describe("shell values starting with '-'", () => {
  it("are refused unless the property sets x-allow-flags", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "decree-harden-"));
    try {
      const ctx: ToolContext = { projectRoot: root, spec: sampleSpec() };
      const refused = await executeShell(shellTool("e", "echo {{msg}}", { msg: { type: "string" } }), { msg: "-n" }, ctx);
      expect(refused).toMatchObject({ isError: true });
      expect(refused.output).toMatch(/parameter values may not start with '-'/);
      const allowed = await executeShell(shellTool("e", "echo {{msg}}", { msg: { type: "string", "x-allow-flags": true } }), { msg: "-x" }, ctx);
      expect(allowed).toEqual({ output: "exit code: 0\n-x\n", isError: false });
      // A placeholder named like an Object.prototype member reads nothing from the prototype.
      expect(renderShellCommand("echo {{constructor}}", {})).toBe("echo");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Secrets in scanner excerpts
// ---------------------------------------------------------------------------

describe("secret masking in scanner excerpts", () => {
  it("masks literal secrets but keeps env references", () => {
    const text = [
      'API_KEY = "abc123xyz"',
      "password: hunter2",
      '{"secret": "s3cr3t", "name": "ok"}',
      "const apiKey: string = 'k-live-1';",
      "const token = process.env.API_TOKEN;",
      "DB_URL=postgres://admin:pa55w0rd@db:5432/app",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "primary_key=True",
    ].join("\n");
    const out = maskSecrets(text);
    for (const leaked of ["abc123xyz", "hunter2", "s3cr3t", "k-live-1", "pa55w0rd", "MIIEowIBAAKCAQEA"]) expect(out).not.toContain(leaked);
    expect(out).toContain('API_KEY = "[REDACTED]"');
    expect(out).toContain("postgres://admin:[REDACTED]@db:5432/app");
    expect(out).toContain("process.env.API_TOKEN");
    expect(out).toContain('"name": "ok"');
    expect(out).toContain("primary_key=True");
  });

  it("scanProject key-file excerpts, the planner digest and profile.json never carry them", async () => {
    const root = path.join(TMP, "scan");
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "leaky", scripts: { test: "vitest run" } }));
    fs.writeFileSync(path.join(root, "src", "config.ts"), 'export const STRIPE_SECRET_KEY = "sk_live_supersecret123";\nexport const port = 3000;\n');
    fs.writeFileSync(path.join(root, "README.md"), "# Leaky\n\nConnect with `DATABASE_URL=postgres://app:readme-pass-42@localhost/app`.\n");
    const profile = await scanProject(root);
    const cfg = profile.keyFiles.find((k) => k.path === "src/config.ts");
    expect(cfg?.excerpt).toContain('STRIPE_SECRET_KEY = "[REDACTED]"');
    expect(JSON.stringify(profile.keyFiles)).not.toContain("sk_live_supersecret123");
    expect(renderProfileDigest(profile)).not.toMatch(/sk_live_supersecret123|readme-pass-42/);
    const saved = await saveProfile(root, profile);
    expect(fs.readFileSync(saved, "utf8")).not.toMatch(/sk_live_supersecret123|readme-pass-42/);
  });

  it("the sample profile digest is unaffected when there is nothing to mask", () => {
    expect(renderProfileDigest(sampleProfile())).toContain("README");
  });
});

// ---------------------------------------------------------------------------
// 4. Claude Code permission breadth
// ---------------------------------------------------------------------------

describe("Claude Code permissions", () => {
  it("puts broad Bash prefixes (generic runners, single words) in ask, never allow", () => {
    const base = sampleSpec();
    const spec: HarnessSpec = {
      ...base,
      tools: [
        shellTool("run_script", "npm run {{script}}"),
        shellTool("run_any", "sh -c {{cmd}}"),
        shellTool("pytest", "pytest {{path}}"),
        shellTool("make_target", "make {{target}}"),
        shellTool("run_tests", "npm test -- {{pattern}}"),
        shellTool("migrate", "npm run migrate"),
      ],
      guardrails: { ...base.guardrails, approvalMode: "never" },
    };
    const p = derivePermissions(spec);
    for (const broad of ["Bash(npm run:*)", "Bash(sh -c:*)", "Bash(pytest:*)", "Bash(make:*)"]) {
      expect(p.ask).toContain(broad);
      expect(p.allow).not.toContain(broad);
    }
    expect(p.allow).toEqual(expect.arrayContaining(["Bash(npm test:*)", "Bash(npm run migrate:*)"]));
  });
});

// ---------------------------------------------------------------------------
// 5. Redact before truncation + same-origin redirects (runtime)
// ---------------------------------------------------------------------------

describe("runtime output hygiene and redirects", () => {
  const spec = hardeningSpec();
  const byName = (n: string) => spec.tools.find((t) => t.name === n)!;

  it("shell output is redacted before the tail is kept, so no piece of a secret survives the cut", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "decree-harden-"));
    try {
      const res = await executeShell(byName("leak_tail"), {}, { projectRoot: root, spec });
      expect(res.output).toMatch(/…\[truncated \d+ chars\]/);
      expect(res.output).not.toContain("TAIL9");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows same-origin redirects (with auth) and never forwards auth to another origin", async () => {
    seenByB.length = 0;
    const ctx: ToolContext = { projectRoot: "/", spec };
    const cross = await executeHttp(byName("redir_cross"), {}, ctx);
    expect(cross.output).toMatch(/^HTTP 302 .*\n\[redirect to http:\/\/127\.0\.0\.1:\d+\/steal not followed: different origin\]/);
    expect(seenByB).toEqual([]);
    const same = await executeHttp(byName("redir_same"), {}, ctx);
    expect(same.output).toMatch(/^HTTP 200 OK\nfinal key=k-hardening-key leak=\[REDACTED:HARDEN_SECRET\]/);
  });
});

// ---------------------------------------------------------------------------
// Generated TypeScript
// ---------------------------------------------------------------------------

type TsResult = { output: string; isError: boolean };

describe("generated TypeScript tools", () => {
  const dir = path.join(TMP, "ts", "typescript");
  const project = path.join(TMP, "ts", "project");
  beforeAll(() => {
    renderTo(dir, generateTypescript(hardeningSpec(), OPTS));
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project, { recursive: true });
    process.env.PROJECT_ROOT = project;
  });
  afterAll(() => delete process.env.PROJECT_ROOT);
  const load = async <T>(rel: string) => (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, rel)).href)) as T;

  it("shell: refuses unsafe templates and leading '-' values; redacts before truncating", async () => {
    const { TOOLS } = await load<{ TOOLS: { definition: { name: string }; run?: (i: Record<string, unknown>) => Promise<TsResult> }[] }>("src/tools/index.ts");
    const run = (name: string, input: Record<string, unknown>) => TOOLS.find((t) => t.definition.name === name)!.run!(input);
    expect(await run("quoted_tpl", { msg: "$(id)" })).toMatchObject({ isError: true, output: expect.stringMatching(/unsafe command template/) });
    expect(await run("echo_msg", { msg: "--help" })).toMatchObject({ isError: true, output: expect.stringMatching(/may not start with '-'/) });
    expect(await run("echo_flag", { flag: "-x" })).toEqual({ output: "exit code: 0\n-x\n", isError: false });
    expect(await run("echo_msg", { msg: "it's" })).toEqual({ output: "exit code: 0\nit's\n", isError: false });
    const tail = await run("leak_tail", {});
    expect(tail.output).toMatch(/…\[truncated/);
    expect(tail.output).not.toContain("TAIL9");
  });

  it("http: same-origin redirects only", async () => {
    seenByB.length = 0;
    const { callHttp } = await load<{ callHttp(i: Record<string, unknown>, b: Record<string, unknown>): Promise<TsResult> }>("src/tools/http.ts");
    const binding = (p: string) => ({ method: "GET", baseUrlEnv: "HARDEN_BASE", path: p, auth: { type: "header", env: "HARDEN_KEY", header: "x-api-key" } });
    const cross = await callHttp({}, binding("/cross"));
    expect(cross.output).toMatch(/not followed: different origin/);
    expect(seenByB).toEqual([]);
    const same = await callHttp({}, binding("/same"));
    expect(same.output).toMatch(/^HTTP 200 OK\nfinal key=k-hardening-key leak=\[REDACTED:HARDEN_SECRET\]/);
  });

  it("memory: refuses paths that leave the memory dir through a symlink", async () => {
    const memDir = path.join(dir, "memories");
    const outside = path.join(TMP, "ts", "outside");
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(path.join(memDir, "evil"), { force: true });
    fs.symlinkSync(outside, path.join(memDir, "evil"));
    const { runMemory } = await load<{ runMemory(i: Record<string, unknown>): Promise<TsResult> }>("src/tools/memory.ts");
    const res = await runMemory({ command: "create", path: "/memories/evil/x.md", file_text: "x" });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(false);
    expect((await runMemory({ command: "create", path: "/memories/notes.md", file_text: "ok" })).isError).toBe(false);
  });

  it("redact ignores values shorter than 4 chars", async () => {
    const { redact } = await load<{ redact(t: string): string }>("src/config.ts");
    expect(redact("abc and " + SECRET)).toBe("abc and [REDACTED:HARDEN_SECRET]");
  });
});

// ---------------------------------------------------------------------------
// 6. Generated TypeScript loop history
// ---------------------------------------------------------------------------

type Block = Record<string, unknown> & { type: string };
type Msg = { role: string; content: unknown };

function assertValidHistory(messages: Msg[]): void {
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    expect(Array.isArray(m.content) ? m.content.length : String(m.content).length, `message ${i} empty`).toBeGreaterThan(0);
    const blocks = (Array.isArray(m.content) ? m.content : []) as Block[];
    const serverIds = new Set(blocks.filter((b) => b.type === "server_tool_use").map((b) => b.id));
    for (const b of blocks) if (b.type.endsWith("_tool_result")) expect(serverIds.has(b.tool_use_id), "orphan server tool result").toBe(true);
    const ids = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const answered = new Set((next!.content as Block[]).map((b) => b.tool_use_id));
    for (const id of ids) expect(answered.has(id), `tool_use ${String(id)} unanswered`).toBe(true);
  });
}

const FAKE_CLIENT_TS = `export const script: any[] = [];
export function anthropic(): any {
  return {
    beta: {
      messages: {
        stream() {
          const step = script.shift();
          return {
            response: {},
            on() { return this; },
            async finalMessage() {
              if (!step) throw new Error("script exhausted");
              return { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 }, stop_details: null, ...step };
            },
          };
        },
      },
    },
  };
}
export function describeError(err: unknown): string { return String(err); }
`;

const LOOP_SCENARIOS: { name: string; script: { content: Block[]; stop_reason: string }[]; expectText?: string }[] = [
  {
    name: "does not keep an empty assistant message",
    script: [
      { content: [{ type: "tool_use", id: "t1", name: "echo_msg", input: { msg: "x" } }], stop_reason: "tool_use" },
      { content: [], stop_reason: "end_turn" },
    ],
  },
  {
    name: "drops unanswerable tool calls on other stop reasons",
    script: [
      { content: [{ type: "text", text: "Reading" }, { type: "tool_use", id: "t1", name: "echo_msg", input: {} }], stop_reason: "model_context_window_exceeded" },
    ],
    expectText: "Reading",
  },
  {
    name: "max_tokens strips server tool results with their server_tool_use",
    script: [
      {
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
          { type: "text", text: "Partial answer" },
          { type: "tool_use", id: "t1", name: "echo_msg", input: {} },
        ],
        stop_reason: "max_tokens",
      },
    ],
    expectText: "Partial answer",
  },
];

describe("generated TypeScript loop keeps history valid", () => {
  const dir = path.join(TMP, "ts-loop", "typescript");
  beforeAll(() => {
    renderTo(dir, generateTypescript(hardeningSpec(), OPTS));
    fs.writeFileSync(path.join(dir, "src/client.ts"), FAKE_CLIENT_TS);
  });

  for (const sc of LOOP_SCENARIOS) {
    it(sc.name, async () => {
      const client = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/client.ts")).href)) as { script: unknown[] };
      const { runLoop } = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/loop.ts")).href)) as {
        runLoop(o: Record<string, unknown>): Promise<{ messages: Msg[] }>;
      };
      const { Session } = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/session.ts")).href)) as { Session: new () => unknown };
      client.script.splice(0, client.script.length, ...JSON.parse(JSON.stringify(sc.script)));
      const res = await runLoop({
        model: "claude-opus-5",
        effort: "high",
        system: "s",
        tools: [],
        messages: [{ role: "user", content: "go" }],
        session: new Session(),
        approve: async () => false,
      });
      assertValidHistory(res.messages);
      if (sc.expectText) expect(JSON.stringify(res.messages)).toContain(sc.expectText);
      else expect(res.messages.at(-1)!.role).toBe("user");
    });
  }
});

// ---------------------------------------------------------------------------
// Generated MCP server
// ---------------------------------------------------------------------------

describe("generated MCP server tools", () => {
  it("apply the same shell, redaction and redirect rules", async () => {
    const dir = path.join(TMP, "mcp", "mcp-server");
    const project = path.join(TMP, "mcp", "project");
    renderTo(dir, generateMcp(hardeningSpec(), OPTS));
    fs.mkdirSync(project, { recursive: true });
    process.env.DECREE_PROJECT_ROOT = project;
    try {
      const tools = (await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "src/tools.ts")).href)) as {
        runTool(name: string, input: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }>;
        redact(t: string): string;
      };
      const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
      const q = await tools.runTool("quoted_tpl", { msg: "$(id)" });
      expect(q.isError).toBe(true);
      expect(text(q)).toMatch(/unsafe command template/);
      const dash = await tools.runTool("echo_msg", { msg: "-rf" });
      expect(dash.isError).toBe(true);
      expect(text(dash)).toMatch(/may not start with '-'/);
      expect(text(await tools.runTool("echo_flag", { flag: "-x" }))).toBe("exit code: 0\n-x\n");
      const tail = await tools.runTool("leak_tail", {});
      expect(text(tail)).toMatch(/…\[truncated/);
      expect(text(tail)).not.toContain("TAIL9");
      expect(tools.redact("abc")).toBe("abc");

      seenByB.length = 0;
      const cross = await tools.runTool("redir_cross", {});
      expect(text(cross)).toMatch(/not followed: different origin/);
      expect(seenByB).toEqual([]);
      expect(text(await tools.runTool("redir_same", {}))).toMatch(/^HTTP 200 OK\nfinal key=k-hardening-key leak=\[REDACTED:HARDEN_SECRET\]/);
    } finally {
      delete process.env.DECREE_PROJECT_ROOT;
    }
  });
});

// ---------------------------------------------------------------------------
// Generated Python
// ---------------------------------------------------------------------------

describe("generated Python", () => {
  const dir = path.join(TMP, "py", "python");
  const stubs = path.join(TMP, "py", "stubs");
  let pkg = "";
  beforeAll(() => {
    const files = generatePython(hardeningSpec(), OPTS);
    renderTo(dir, files);
    pkg = files.find((f) => f.path.endsWith("/tools/http.py"))!.path.split("/")[0]!;
    fs.mkdirSync(stubs, { recursive: true });
    // Minimal stubs so the package imports without its real dependencies.
    fs.writeFileSync(path.join(stubs, "httpx.py"), "class HTTPError(Exception):\n    pass\n\ndef request(**kw):\n    raise HTTPError('stub')\n");
    fs.writeFileSync(path.join(stubs, "anthropic.py"), "class Anthropic:\n    pass\n");
  });

  function py(code: string): { stdout: string; stderr: string } | undefined {
    const res = spawnSync("python3", ["-c", code], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: `${dir}${path.delimiter}${stubs}`, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // no python3
    return { stdout: res.stdout, stderr: res.stderr };
  }

  it("shell: refuses unsafe templates and leading '-' values; redacts before truncating; redact min length", () => {
    const res = py(
      [
        "from pathlib import Path",
        `from ${pkg}.tools.shell import render_command, run_shell, UnsafeCommand`,
        `from ${pkg}.tools.base import redact`,
        `from ${pkg}.tools.registry import TOOLS_BY_NAME`,
        "root = Path('.').resolve()",
        "for tpl, args in (('echo \"{{x}}\"', {'x': 'a'}), ('echo {{x}}', {'x': '-rf'}), ('echo `{{x}}`', {'x': 'a'})):",
        "    try:",
        "        render_command(tpl, args); print('RENDERED')",
        "    except UnsafeCommand as e:",
        "        print('REFUSED', e)",
        "print(render_command('echo {{x}}', {'x': '-x'}, ['x']))",
        "print(run_shell(TOOLS_BY_NAME['quoted_tpl'].binding, {'msg': 'a'}, root).output)",
        "print(repr(run_shell(TOOLS_BY_NAME['echo_flag'].binding, {'flag': '-x'}, root).output))",
        "tail = run_shell(TOOLS_BY_NAME['leak_tail'].binding, {}, root).output",
        "print('LEAK' if 'TAIL9' in tail else 'CLEAN')",
        "print(redact('abc'))",
      ].join("\n"),
    );
    if (!res) return;
    expect(res.stderr).toBe("");
    expect(res.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(/^REFUSED unsafe command template/),
      expect.stringMatching(/^REFUSED parameter values may not start with '-'/),
      expect.stringMatching(/^REFUSED unsafe command template/),
      "echo '-x'",
      expect.stringMatching(/^Refused: unsafe command template/),
      "'exit code: 0\\n-x\\n'",
      "CLEAN",
      "abc",
    ]);
  });

  it("http does not follow redirects automatically", () => {
    const src = fs.readFileSync(path.join(dir, pkg, "tools", "http.py"), "utf8");
    expect(src).toContain("follow_redirects=False");
    expect(src).not.toContain("follow_redirects=True");
  });

  it("the agent loop keeps history valid", () => {
    const res = py(
      [
        "import json",
        "from types import SimpleNamespace as NS",
        `from ${pkg}.agent import Agent`,
        "def blk(**kw): return NS(**kw)",
        "class Stream:",
        "    def __init__(self, msg): self.msg = msg",
        "    def __enter__(self): return self",
        "    def __exit__(self, *a): return False",
        "    def __iter__(self): return iter(())",
        "    def get_final_message(self): return self.msg",
        "class Client:",
        "    def __init__(self, script): self.script = list(script); self.messages = self; self.beta = NS(messages=self)",
        "    def stream(self, **kw): return Stream(self.script.pop(0))",
        "def msg(content, stop): return NS(content=content, stop_reason=stop, usage=NS(input_tokens=1, output_tokens=1), stop_details=None)",
        "scenarios = [",
        "  [msg([blk(type='tool_use', id='t1', name='echo_msg', input={'msg': 'x'})], 'tool_use'), msg([], 'end_turn')],",
        "  [msg([blk(type='text', text='Reading'), blk(type='tool_use', id='t1', name='echo_msg', input={})], 'model_context_window_exceeded')],",
        "  [msg([blk(type='server_tool_use', id='s1', name='web_search', input={}), blk(type='web_search_tool_result', tool_use_id='s1', content=[]),",
        "       blk(type='text', text='Partial answer'), blk(type='tool_use', id='t1', name='echo_msg', input={})], 'max_tokens')],",
        "]",
        "for script in scenarios:",
        "    agent = Agent(client=Client(script), approve=lambda t, a: True)",
        "    agent.run('go')",
        "    out = []",
        "    for m in agent.messages:",
        "        c = m['content']",
        "        out.append({'role': m['role'], 'content': c if isinstance(c, str) else [",
        "            (b if isinstance(b, dict) else {'type': b.type, 'id': getattr(b, 'id', None), 'tool_use_id': getattr(b, 'tool_use_id', None), 'text': getattr(b, 'text', None)}) for b in c]})",
        "    print(json.dumps(out))",
      ].join("\n"),
    );
    if (!res) return;
    expect(res.stderr).toBe("");
    const runs = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Msg[]);
    expect(runs).toHaveLength(3);
    runs.forEach((messages) => assertValidHistory(messages));
    expect(runs[0]!.at(-1)!.role).toBe("user");
    expect(JSON.stringify(runs[1])).toContain("Reading");
    expect(JSON.stringify(runs[2])).toContain("Partial answer");
  });
});
