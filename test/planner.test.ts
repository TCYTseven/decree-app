import { describe, expect, it } from "vitest";
import type { ApiEndpoint, ProjectProfile } from "../src/core/types.js";
import { validateSpec } from "../src/core/spec.js";
import { planHarness, planHeuristic, renderProfileDigest } from "../src/planner/index.js";
import { analyzeGoal, classifyScript, isDestructiveEndpoint, MAX_HTTP_TOOLS, scriptCommand } from "../src/planner/heuristic.js";
import { sampleProfile } from "./helpers/sample-spec.js";

const GOAL = "Help on-call engineers inspect orders, run tests, and triage failures.";

function manyEndpoints(n: number): ApiEndpoint[] {
  const resources = ["users", "orders", "invoices", "products", "shipments", "reviews", "carts", "coupons"];
  const out: ApiEndpoint[] = [];
  for (let i = 0; out.length < n; i++) {
    const r = resources[i % resources.length]!;
    const v = Math.floor(i / resources.length);
    const base = `/v1/${r}${v ? `/sub${v}` : ""}`;
    out.push(
      { method: "GET", path: base, summary: `List ${r}`, params: [], source: "openapi.yaml" },
      { method: "GET", path: `${base}/{id}`, summary: `Get ${r}`, params: [{ name: "id", in: "path", required: true }], source: "openapi.yaml" },
      { method: "POST", path: base, summary: `Create ${r}`, params: [], requestBody: { type: "object", properties: { name: { type: "string" } } }, source: "openapi.yaml" },
      { method: "DELETE", path: `${base}/{id}`, summary: `Delete ${r}`, params: [{ name: "id", in: "path", required: true }], source: "openapi.yaml" },
    );
  }
  return out.slice(0, n);
}

describe("planHeuristic", () => {
  it("builds a valid spec from the sample profile", () => {
    const spec = planHeuristic(sampleProfile(), { goal: GOAL, targets: ["typescript"] });
    const v = validateSpec(spec);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.warnings).toEqual([]);
    const names = spec.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_orders", "get_order", "cancel_order", "run_tests", "run_lint", "read_file", "list_files", "search_code"]));
    expect(spec.name).toBe("acme-agent");
    expect(spec.provenance.generator).toBe("heuristic");
    expect(spec.provenance.notes?.length).toBeGreaterThan(0);
    expect(spec.targets).toEqual(["typescript"]);
  });

  it("binds http tools correctly", () => {
    const spec = planHeuristic(sampleProfile(), { goal: GOAL, targets: ["typescript"] });
    const list = spec.tools.find((t) => t.name === "list_orders")!;
    expect(list.http).toMatchObject({ method: "GET", path: "/orders", baseUrlEnv: "ACME_BASE_URL", defaultBaseUrl: "http://localhost:3000", queryParams: ["status"] });
    expect(list.http!.auth).toEqual({ type: "bearer", env: "ACME_API_TOKEN" });
    expect(list.readOnly).toBe(true);
    const cancel = spec.tools.find((t) => t.name === "cancel_order")!;
    expect(cancel.inputSchema.required).toEqual(expect.arrayContaining(["id", "reason"]));
    expect(cancel.http!.bodyParam).toBeUndefined();
    expect(cancel).toMatchObject({ readOnly: false, destructive: true, requiresApproval: true });
    expect(cancel.description).toMatch(/POST \/orders\/\{id\}\/cancel/);
    expect(spec.env.map((e) => e.name)).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ACME_BASE_URL", "ACME_API_TOKEN"]));
    expect(spec.guardrails.redactEnv).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ACME_API_TOKEN"]));
  });

  it("uses a body param when the request body is not an object", () => {
    const profile = sampleProfile({
      apis: [{ method: "PUT", path: "/tags", params: [], requestBody: { type: "array", items: { type: "string" } }, source: "openapi.yaml" }],
    });
    const t = planHeuristic(profile, { goal: GOAL, targets: ["typescript"] }).tools.find((x) => x.kind === "http")!;
    expect(t.name).toBe("update_tags");
    expect(t.http!.bodyParam).toBe("body");
    expect(t.inputSchema.properties!.body).toMatchObject({ type: "array" });
  });

  it("caps http tools and notes the omission", () => {
    const profile = sampleProfile({ apis: manyEndpoints(100) });
    const spec = planHeuristic(profile, { goal: GOAL, targets: ["typescript"] });
    const http = spec.tools.filter((t) => t.kind === "http");
    expect(http.length).toBe(MAX_HTTP_TOOLS);
    // Spread across resources: every resource keeps its list endpoint.
    for (const r of ["users", "orders", "invoices", "products", "shipments", "reviews", "carts", "coupons"]) {
      expect(http.some((t) => t.http!.path === `/v1/${r}` && t.http!.method === "GET")).toBe(true);
    }
    expect(spec.provenance.notes!.some((n) => /omitted 60/.test(n))).toBe(true);
    expect(validateSpec(spec).ok).toBe(true);
    // Large tool surface -> split subagents, read-only only.
    expect(spec.subagents.map((s) => s.name)).toEqual(expect.arrayContaining(["api-investigator", "code-investigator"]));
    for (const s of spec.subagents) {
      for (const n of s.tools) expect(spec.tools.find((t) => t.name === n)!.destructive).toBe(false);
    }
  });

  it("classifies destructive endpoints and scripts", () => {
    const e = (method: ApiEndpoint["method"], path: string, operationId?: string) => ({ method, path, operationId });
    expect(isDestructiveEndpoint(e("DELETE", "/users/{id}"))).toBe(true);
    expect(isDestructiveEndpoint(e("POST", "/orders/{id}/refund"))).toBe(true);
    expect(isDestructiveEndpoint(e("POST", "/emails", "sendEmail"))).toBe(true);
    expect(isDestructiveEndpoint(e("POST", "/orders", "createOrder"))).toBe(false);
    expect(isDestructiveEndpoint(e("GET", "/orders/{id}/cancel"))).toBe(false);
    expect(classifyScript({ name: "deploy", command: "vercel --prod" })).toBe("deploy");
    expect(classifyScript({ name: "db:migrate", command: "prisma migrate deploy" })).toBe("migrate");
    expect(classifyScript({ name: "db:reset", command: "prisma migrate reset" })).toBe("db-reset");
    expect(classifyScript({ name: "dev", command: "vite" })).toBe("server");
    expect(classifyScript({ name: "typecheck", command: "tsc --noEmit" })).toBe("typecheck");
    expect(classifyScript({ name: "format:check", command: "prettier --check ." })).toBe("format-check");
    expect(classifyScript({ name: "pretest", command: "npm run build" })).toBe("other");
  });

  it("gates destructive scripts, skips servers, and uses the package manager", () => {
    const profile = sampleProfile({
      packageManager: "pnpm",
      scripts: [
        { name: "test", command: "vitest run", source: "package.json" },
        { name: "dev", command: "vite", source: "package.json" },
        { name: "deploy", command: "vercel --prod", source: "package.json" },
        { name: "migrate", command: "alembic upgrade head", source: "Makefile" },
      ],
    });
    const spec = planHeuristic(profile, { goal: GOAL, targets: ["typescript"] });
    const tests = spec.tools.find((t) => t.name === "run_tests")!;
    expect(tests.shell!.command).toBe("pnpm run test {{filter}}");
    expect(spec.tools.some((t) => t.shell?.command.includes(" dev"))).toBe(false);
    const deploy = spec.tools.find((t) => t.name === "run_deploy")!;
    expect(deploy).toMatchObject({ destructive: true, requiresApproval: true, readOnly: false });
    expect(spec.tools.find((t) => t.name === "run_migrate")!.shell!.command).toBe("make migrate");
    expect(spec.provenance.notes!.some((n) => /long-running/.test(n))).toBe(true);
    expect(scriptCommand(sampleProfile({ packageManager: "uv" }), { name: "test", command: "pytest -q", source: "pyproject.toml" }, "filter")).toBe(
      "uv run pytest -q {{filter}}",
    );
  });

  it("reacts to goal keywords", () => {
    const readOnly = planHeuristic(sampleProfile(), { goal: "A read-only assistant that explains how orders work and fixes nothing.", targets: ["typescript"] });
    expect(readOnly.tools.some((t) => t.kind === "write_file")).toBe(false);
    expect(readOnly.tools.some((t) => t.destructive)).toBe(false);
    expect(readOnly.systemPrompt).toMatch(/read-only/);

    const coder = planHeuristic(sampleProfile(), { goal: "Fix bugs and implement small features in the orders service.", targets: ["typescript"] });
    const write = coder.tools.find((t) => t.kind === "write_file")!;
    expect(write).toMatchObject({ destructive: true, requiresApproval: true });
    expect(coder.systemPrompt).toMatch(/verify/i);

    const research = planHeuristic(sampleProfile(), { goal: "Research the latest Express docs and remember decisions across sessions.", targets: ["typescript"] });
    expect(research.tools.map((t) => t.kind)).toEqual(expect.arrayContaining(["web_search", "web_fetch", "memory"]));
    expect(research.context.memory).toBe(true);
    expect(validateSpec(research).ok).toBe(true);

    expect(analyzeGoal("Answer questions about orders").write).toBe(false);
  });

  it("generates evals covering tool choice, restraint, tests and scope", () => {
    const spec = planHeuristic(sampleProfile(), { goal: GOAL, targets: ["typescript"] });
    expect(spec.evals.length).toBeGreaterThanOrEqual(5);
    expect(spec.evals.length).toBeLessThanOrEqual(10);
    const ids = spec.evals.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["read-orders-list", "confirm-before-cancel-order", "run-tests", "out-of-scope"]));
    const confirm = spec.evals.find((e) => e.id === "confirm-before-cancel-order")!;
    expect(confirm.expect.toolsNotCalled).toEqual(["cancel_order"]);
    expect(confirm.expect.rubric).toMatch(/confirm/);
    expect(spec.evals.find((e) => e.id === "run-tests")!.expect.toolsCalled).toEqual(["run_tests"]);
    const names = new Set(spec.tools.map((t) => t.name));
    for (const e of spec.evals) for (const n of [...(e.expect.toolsCalled ?? []), ...(e.expect.toolsNotCalled ?? [])]) expect(names.has(n)).toBe(true);
  });

  it("writes a project-specific, calm system prompt", () => {
    const spec = planHeuristic(sampleProfile(), { goal: GOAL, targets: ["typescript"] });
    const p = spec.systemPrompt;
    expect(p).toContain("acme");
    expect(p).toContain("npm run test");
    expect(p).toContain("ACME_BASE_URL");
    expect(p).toContain(GOAL);
    expect(p).toMatch(/# Safety/);
    expect(p).toMatch(/cancel_order/);
    expect(p).not.toMatch(/\b(MUST|NEVER|CRITICAL|IMPORTANT)\b/);
  });

  it("handles a bare profile (no apis, no scripts)", () => {
    const profile = sampleProfile({ apis: [], scripts: [], envVars: [], openapiSpecs: [], database: undefined, frameworks: [] });
    const spec = planHeuristic(profile, { goal: "", targets: ["typescript"] });
    expect(spec.tools.map((t) => t.name)).toEqual(["read_file", "list_files", "search_code"]);
    expect(spec.subagents).toEqual([]);
    expect(validateSpec(spec).ok).toBe(true);
  });
});

describe("planHarness (offline)", () => {
  it("fills identity fields", async () => {
    const progress: string[] = [];
    const spec = await planHarness(sampleProfile(), { goal: GOAL, targets: ["typescript", "mcp"], model: "claude-opus-5-5", onProgress: (m) => progress.push(m) });
    expect(spec.version).toBe(1);
    expect(spec.model.id).toBe("claude-opus-5-5");
    expect(spec.targets).toEqual(["typescript", "mcp"]);
    expect(spec.provenance.profileName).toBe("acme");
    expect(spec.provenance.decreeVersion).toBeTruthy();
    expect(Date.parse(spec.provenance.createdAt)).not.toBeNaN();
    expect(progress).toContain("Validating");
  });
});

describe("renderProfileDigest", () => {
  it("renders the key facts compactly", () => {
    const d = renderProfileDigest(sampleProfile());
    expect(d).toContain("# Project: acme");
    expect(d).toContain("POST /orders/{id}/cancel");
    expect(d).toContain("reason*:string");
    expect(d).toContain("ACME_API_TOKEN (secret)");
    expect(d).toContain("test [package.json]: vitest run");
    expect(d).toContain("src/index.ts (entrypoint)");
  });

  it("stays under the cap, trimming key files first", () => {
    const big: ProjectProfile = sampleProfile({
      apis: manyEndpoints(300),
      keyFiles: Array.from({ length: 40 }, (_, i) => ({ path: `src/file${i}.ts`, reason: "router", excerpt: "x".repeat(10000) })),
      tree: "t\n".repeat(20000),
      docs: { readme: "r".repeat(20000), files: ["README.md"] },
    });
    const d = renderProfileDigest(big, { maxChars: 60000 });
    expect(d.length).toBeLessThanOrEqual(60000);
    expect(d).toContain("GET /v1/users");
    expect(d).toContain("## Key files");
  });
});

describe("heuristic naming and goal gating (QA regressions)", () => {
  it("derives REST-style names for routes without an operationId", async () => {
    const { restToolName } = await import("../src/planner/heuristic.js");
    const cases: [string, string, string][] = [
      ["GET", "/api/notes", "list_notes"],
      ["GET", "/api/notes/{id}", "get_note"],
      ["POST", "/api/notes", "create_note"],
      ["PATCH", "/api/notes/[id]", "update_note"],
      ["DELETE", "/api/notes/:id", "delete_note"],
      ["GET", "/orders/{id}/events", "list_order_events"],
      ["POST", "/orders/{id}/cancel", "cancel_order"],
      ["POST", "/articles/{slug}/comments", "create_article_comment"],
      ["DELETE", "/articles/{slug}/favorite", "unfavorite_article"],
      ["POST", "/users/login", "login"],
      ["POST", "/api/v1/admin/purge", "purge"],
      ["GET", "/api/search", "search"],
      ["GET", "/api/session", "get_session"],
      ["GET", "/health", "get_health"],
      ["PUT", "/tags", "update_tags"],
    ];
    for (const [m, p, want] of cases) expect(restToolName(m, p), `${m} ${p}`).toBe(want);
  });

  it("does not treat 'look up' or 'online' as a research goal", () => {
    expect(analyzeGoal("Help support engineers look up customer orders").research).toBe(false);
    expect(analyzeGoal("Answer questions about our online store").research).toBe(false);
    expect(analyzeGoal("Research the latest library docs").research).toBe(true);
  });

  it("leaves deploy/migrate scripts out of support goals but keeps them as LLM candidates", async () => {
    const { planHeuristicDetailed } = await import("../src/planner/heuristic.js");
    const profile = sampleProfile({
      scripts: [
        { name: "test", command: "vitest run", source: "package.json" },
        { name: "deploy", command: "fly deploy", source: "package.json" },
        { name: "db:push", command: "drizzle-kit push", source: "package.json" },
      ],
    });
    const support = planHeuristicDetailed(profile, { goal: "Answer customer support questions about orders", targets: ["typescript"] });
    expect(support.intent.ops).toBe(false);
    expect(support.spec.tools.some((t) => t.name === "run_deploy" || t.name === "run_db_push")).toBe(false);
    expect(support.candidateTools.map((t) => t.name)).toEqual(expect.arrayContaining(["run_deploy", "run_db_push"]));
    const ops = planHeuristicDetailed(profile, { goal: "Help on-call engineers deploy and run migrations", targets: ["typescript"] });
    expect(ops.spec.tools.find((t) => t.name === "run_db_push")).toMatchObject({ destructive: true, requiresApproval: true });
    expect(ops.spec.tools.find((t) => t.name === "run_db_push")!.description).toMatch(/Push the schema/);
    // Test/lint scripts run project code: not readOnly (the runtime runs readOnly tools in parallel, unapproved).
    expect(ops.spec.tools.find((t) => t.name === "run_tests")).toMatchObject({ readOnly: false, destructive: false, requiresApproval: false });
  });

  it("classifies db:push as a migration and a Makefile `run` target as a server", () => {
    expect(classifyScript({ name: "db:push", command: "drizzle-kit push" })).toBe("migrate");
    expect(classifyScript({ name: "run", command: "./bin/app" })).toBe("server");
  });

  it("does not offer a filter param to Make targets", () => {
    const spec = planHeuristic(sampleProfile({ scripts: [{ name: "test", command: "go test ./...", source: "Makefile" }] }), { goal: GOAL, targets: ["typescript"] });
    const t = spec.tools.find((x) => x.name === "run_tests")!;
    expect(t.shell!.command).toBe("make test");
    expect(t.inputSchema.properties).toEqual({});
  });

  it("skips webhook receivers", async () => {
    const { isWebhookReceiver } = await import("../src/planner/heuristic.js");
    const apis = [
      { method: "POST" as const, path: "/api/webhooks/{provider}" },
      { method: "POST" as const, path: "/hooks" },
      { method: "GET" as const, path: "/hooks" },
    ];
    expect(isWebhookReceiver(apis[0]!, apis)).toBe(true);
    expect(isWebhookReceiver(apis[1]!, apis)).toBe(false); // a managed collection (has a GET), not a receiver
  });

  it("title-cases acronyms", async () => {
    const { titleCase, article } = await import("../src/planner/util.js");
    expect(titleCase("inventory-api-agent")).toBe("Inventory API Agent");
    expect(article("order")).toBe("an");
    expect(article("user")).toBe("a");
  });
});
