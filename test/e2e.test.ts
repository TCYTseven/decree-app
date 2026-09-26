/**
 * End-to-end offline pipeline on every fixture: scanProject -> planHarness -> validateSpec -> generateTargets,
 * then write to disk and re-scan. Asserts the product-level properties a real user would notice
 * (tool names, safety flags, commands for the right package manager, ports, evals, run lines).
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessSpec, Target, ToolSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/spec.js";
import { writeFiles } from "../src/core/writer.js";
import { generateTargets } from "../src/generators/index.js";
import { planHarness } from "../src/planner/index.js";
import { scanProject } from "../src/scanner/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const ALL: Target[] = ["typescript", "python", "mcp", "claude-code"];
const SUPPORT_GOAL = "Help support engineers look up and manage customer records and answer questions";
const OPS_GOAL = "Help on-call engineers investigate incidents, run tests, deploy and run migrations";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function pipeline(fixture: string, goal = SUPPORT_GOAL) {
  const profile = await scanProject(path.join(FIXTURES, fixture));
  const spec = await planHarness(profile, { goal, targets: ALL });
  const v = validateSpec(JSON.parse(JSON.stringify(spec)));
  expect(v.ok, v.ok ? "" : JSON.stringify(v)).toBe(true);
  const files = generateTargets(spec, ALL, { outDir: "agent", decreeVersion: "0.0.0-test" });
  const byPath = new Map(files.map((f) => [f.path, String(f.content)]));
  return { profile, spec, files, byPath };
}

const tool = (spec: HarnessSpec, name: string): ToolSpec => {
  const t = spec.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}; have ${spec.tools.map((x) => x.name).join(", ")}`);
  return t;
};

function commonChecks(spec: HarnessSpec, byPath: Map<string, string>) {
  const names = new Set(spec.tools.map((t) => t.name));
  // Every eval references real tools.
  for (const e of spec.evals) for (const n of [...(e.expect.toolsCalled ?? []), ...(e.expect.toolsNotCalled ?? [])]) expect(names.has(n)).toBe(true);
  // No overview question about plumbing endpoints.
  for (const e of spec.evals) expect(e.input).not.toMatch(/current (health|healthz|session|search|root)\b/);
  // Destructive tools always need approval; readOnly tools are never destructive.
  for (const t of spec.tools) {
    if (t.destructive) expect(t.requiresApproval).toBe(true);
    if (t.readOnly) expect(t.destructive).toBe(false);
    // Shell commands run project code: never marked side-effect free.
    if (t.kind === "shell") expect(t.readOnly).toBe(false);
    // A shell tool never advertises a parameter its command ignores.
    if (t.kind === "shell") for (const p of Object.keys(t.inputSchema.properties ?? {})) expect(t.shell!.command).toContain(`{{${p}}}`);
    // REST-style names, not path dumps.
    expect(t.name).not.toMatch(/(^|_)(get|post|put|patch|delete)_api_|_by_[a-z]+/);
    expect(t.description).not.toMatch(/\ba [aeio]\w/i); // "a order", "a item"
  }
  // Generated layout.
  for (const p of ["README.md", "harness.md", "evals.json", "typescript/src/cli.ts", "mcp-server/src/server.ts", "claude-code/.mcp.json", "claude-code/.claude/settings.json"]) {
    expect(byPath.has(p), p).toBe(true);
  }
  const pyPkg = [...byPath.keys()].find((p) => /^python\/[a-z0-9_]+\/__main__\.py$/.test(p))!;
  expect(pyPkg).toBeTruthy();
  const pkg = pyPkg.split("/")[1]!;
  const readme = byPath.get("README.md")!;
  // The Python run line names the real console script and points the tools back at the project root.
  expect(readme).toContain(`uv run ${spec.name} --root ../..`);
  expect(readme).toContain(`python -m ${pkg}`);
  expect(readme).not.toContain("python -m agent`");
  // .mcp.json resolves tsx from the generated server's own install.
  const mcp = JSON.parse(byPath.get("claude-code/.mcp.json") ?? "{}");
  const server = Object.values(mcp.mcpServers ?? {})[0] as { command: string; args: string[] } | undefined;
  if (server) expect(server.args).toEqual(["--prefix", "agent/mcp-server", "tsx", "agent/mcp-server/src/server.ts"]);
}

describe("offline pipeline on fixtures", () => {
  it("express-openapi: OpenAPI + code routes, npm scripts, bearer auth", async () => {
    const { spec, byPath } = await pipeline("express-openapi", "Help support engineers look up and manage customer orders");
    commonChecks(spec, byPath);
    expect(tool(spec, "list_orders").http).toMatchObject({ method: "GET", path: "/orders", defaultBaseUrl: "http://localhost:3000" });
    expect(tool(spec, "list_orders").http!.auth).toEqual({ type: "bearer", env: "ACME_API_TOKEN" });
    expect(tool(spec, "cancel_order")).toMatchObject({ destructive: true, requiresApproval: true, readOnly: false });
    expect(tool(spec, "delete_order")).toMatchObject({ destructive: true, requiresApproval: true });
    // Code-detected route without operationId gets a REST name and a sensible description.
    expect(tool(spec, "list_order_events").description).toMatch(/^Lists the events of an order \(GET \/orders\/\{id\}\/events\)/);
    expect(tool(spec, "create_order").description).toContain("create an order");
    expect(tool(spec, "run_tests").shell!.command).toBe("npm run test -- {{filter}}");
    // "look up customer orders" is not a research goal.
    expect(spec.tools.some((t) => t.kind === "web_search")).toBe(false);
    // Support goal: no deploy / migrate / seed tools, and the note says why.
    expect(spec.tools.some((t) => /^run_(deploy|db_migrate|db_seed)$/.test(t.name))).toBe(false);
    expect(spec.provenance.notes!.some((n) => /not about operating the system/.test(n))).toBe(true);
    expect(spec.evals.find((e) => e.id === "code-grounding")!.input).toContain("order logic");
    expect(spec.evals.find((e) => e.id === "confirm-before-delete-order")!.input).toBe("Delete order 42, it was posted by mistake.");
  });

  it("express-openapi with an ops goal keeps deploy/migrate/seed behind approval", async () => {
    const { spec } = await pipeline("express-openapi", OPS_GOAL);
    for (const n of ["run_deploy", "run_db_migrate", "run_db_seed"]) expect(tool(spec, n)).toMatchObject({ destructive: true, requiresApproval: true });
  });

  it("fastapi-app: uv commands, port 8000, action endpoints", async () => {
    const { spec, byPath } = await pipeline("fastapi-app", OPS_GOAL);
    commonChecks(spec, byPath);
    expect(spec.displayName).toBe("Inventory API Agent");
    expect(tool(spec, "list_items").http!.defaultBaseUrl).toBe("http://localhost:8000");
    expect(tool(spec, "run_tests").shell!.command).toBe("uv run pytest -q {{filter}}");
    expect(tool(spec, "run_migrate").shell!.command).toBe("uv run alembic upgrade head");
    expect(tool(spec, "reindex").description).toMatch(/only when the user asks for this operation/);
    expect(tool(spec, "reindex").description).not.toMatch(/create or submit/);
    expect(tool(spec, "get_item").inputSchema.properties!.item_id!.description).toBe("ID of the item, e.g. 42");
    expect(byPath.get("README.md")).toContain("uv run inventory-api-agent --root ../..");
  });

  it("nextjs-app: pnpm, REST names for app-router routes, webhook receivers left out, db:push gated", async () => {
    const { spec, byPath } = await pipeline("nextjs-app", OPS_GOAL);
    commonChecks(spec, byPath);
    const http = spec.tools.filter((t) => t.kind === "http").map((t) => t.name);
    expect(http).toEqual(expect.arrayContaining(["list_notes", "create_note", "get_note", "update_note", "delete_note", "search_notes", "get_session"]));
    expect(spec.tools.some((t) => /webhook/.test(t.http?.path ?? ""))).toBe(false);
    expect(spec.provenance.notes!.some((n) => /webhook receiver/.test(n))).toBe(true);
    expect(tool(spec, "run_tests").shell!.command).toBe("pnpm run test {{filter}}");
    expect(tool(spec, "run_db_push")).toMatchObject({ destructive: true, requiresApproval: true });
    expect(tool(spec, "search_notes").description).toMatch(/Use it to search \(with `q`\)/);
  });

  it("go-gin: make targets, port 8080, no fake filter param, `run` treated as a server", async () => {
    const { spec, byPath } = await pipeline("go-gin", OPS_GOAL);
    commonChecks(spec, byPath);
    expect(tool(spec, "list_tasks").http!.defaultBaseUrl).toBe("http://localhost:8080");
    const tests = tool(spec, "run_tests");
    expect(tests.shell!.command).toBe("make test");
    expect(tests.inputSchema.properties).toEqual({});
    expect(tests.description).not.toMatch(/filter/);
    expect(tool(spec, "purge_completed").description).not.toMatch(/for the specific/);
    expect(spec.provenance.notes!.some((n) => /long-running script\(s\) `run`/.test(n))).toBe(true);
    expect(spec.tools.some((t) => t.shell?.command === "make run")).toBe(false);
  });
});

describe("re-scanning after generation", () => {
  it("ignores the generated harness (manifest-tracked output) as project metadata", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "decree-e2e-"));
    tmpDirs.push(dir);
    cpSync(path.join(FIXTURES, "go-gin"), dir, { recursive: true });
    const before = await scanProject(dir);
    const spec = await planHarness(before, { goal: OPS_GOAL, targets: ALL });
    const files = generateTargets(spec, ALL, { outDir: "agent", decreeVersion: "0.0.0-test" });
    await writeFiles(path.join(dir, "agent"), files, { manifestPath: path.join(dir, ".decree", "manifest.json") });

    const after = await scanProject(dir);
    expect(after.name).toBe(before.name);
    expect(after.primaryLanguage).toBe("Go");
    expect(after.packageManager).toBe(before.packageManager);
    expect(after.cli).toEqual(before.cli);
    expect(after.envVars.map((v) => v.name).sort()).toEqual(before.envVars.map((v) => v.name).sort());
    expect(after.dependencies.map((d) => d.name).sort()).toEqual(before.dependencies.map((d) => d.name).sort());
    // Re-planning gives the same tool surface.
    const again = await planHarness(after, { goal: OPS_GOAL, targets: ALL });
    expect(again.tools.map((t) => t.name)).toEqual(spec.tools.map((t) => t.name));
  });
});
