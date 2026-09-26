/**
 * Harness-quality rubric: the offline scorer (src/planner/quality.ts) flags what a senior agent engineer
 * would flag in review, and the heuristic planner's output clears it on every fixture.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApiEndpoint, HarnessSpec, ToolSpec } from "../src/core/types.js";
import { specJsonSchema } from "../src/core/spec.js";
import { planHeuristic, planHeuristicDetailed } from "../src/planner/heuristic.js";
import { ARCHITECT_SYSTEM, CRITIC_SCHEMA, CRITIC_SYSTEM, RUBRIC_DIMENSIONS } from "../src/planner/prompts.js";
import { formatQualityReport, scoreHarness, sentences } from "../src/planner/quality.js";
import { scanProject } from "../src/scanner/index.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const checks = (spec: HarnessSpec) => scoreHarness(spec).findings.map((f) => f.check);

function httpTool(over: Partial<ToolSpec> & { name: string; method?: string; path?: string }): ToolSpec {
  const { method = "GET", path: p = "/orders", ...rest } = over;
  return {
    description: "Lists orders, optionally filtered by status (GET /orders). Use it to find an order id. Returns the orders as JSON.",
    kind: "http",
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method: method as "GET", baseUrlEnv: "ACME_BASE_URL", path: p, auth: { type: "none" } },
    readOnly: method === "GET",
    destructive: false,
    requiresApproval: false,
    ...rest,
  };
}

describe("scoreHarness", () => {
  it("grades a terse hand-written spec as mediocre without hard errors", () => {
    // sampleSpec() is safe but thin: short descriptions, a 42-word prompt, two evals, an unneeded subagent.
    const r = scoreHarness(sampleSpec(), sampleProfile());
    expect(r.score).toBeGreaterThan(40);
    expect(r.score).toBeLessThan(80);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.categories.systemPrompt.score).toBeLessThan(50);
    expect(Object.keys(r.categories).sort()).toEqual(["descriptions", "evals", "naming", "safety", "schemas", "subagents", "surface", "systemPrompt"]);
    expect(Object.values(r.categories).reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it("flags weak tool descriptions", () => {
    const spec = sampleSpec({
      tools: [
        httpTool({ name: "list_orders", description: "List orders." }),
        httpTool({ name: "get_order", path: "/orders/{id}", description: "This tool allows you to get an order. It is useful. It works. It is fast. It is great." }),
      ],
    });
    const c = checks(spec);
    expect(c).toContain("description.restates-name");
    expect(c).toContain("description.when");
    expect(c).toContain("description.returns");
    expect(c).toContain("description.filler");
    expect(c).toContain("description.length");
  });

  it("flags non verb_noun names and numeric collision suffixes", () => {
    const spec = sampleSpec({
      tools: [httpTool({ name: "create_user", method: "POST", path: "/users" }), httpTool({ name: "create_user_2", method: "POST", path: "/private/users" }), httpTool({ name: "articles_index" })],
    });
    const r = scoreHarness(spec);
    expect(r.findings.find((f) => f.check === "name.collision-suffix")?.message).toMatch(/create_private_user/);
    expect(r.findings.some((f) => f.check === "name.verb_noun" && f.target === "articles_index")).toBe(true);
  });

  it("flags undescribed and untyped inputs", () => {
    const spec = sampleSpec({
      tools: [
        httpTool({
          name: "get_article",
          path: "/articles/{slug}",
          inputSchema: { type: "object", properties: { slug: { type: "string", description: "`slug` (path parameter)" }, x: { description: "Something useful here" } }, required: ["slug"] },
        }),
      ],
    });
    const c = checks(spec);
    expect(c).toContain("param.description");
    expect(c).toContain("param.type");
    expect(c).toContain("param.example");
  });

  it("flags overlapping tools and broken bindings", () => {
    const spec = sampleSpec({
      tools: [
        httpTool({ name: "list_orders" }),
        httpTool({ name: "get_orders" }),
        httpTool({ name: "update_order", method: "PUT", path: "/orders/{id}", readOnly: false }),
        httpTool({ name: "patch_order", method: "PATCH", path: "/orders/{id}", readOnly: false }),
        httpTool({ name: "get_feed", path: "/^api/^feed/?$" }),
      ],
    });
    const c = checks(spec);
    expect(c).toContain("surface.duplicate-endpoint");
    expect(c).toContain("surface.put-patch");
    expect(c).toContain("surface.suspicious-path");
    expect(c).toContain("surface.no-body");
  });

  it("flags ungated destructive actions, readOnly mutations and free-form shell", () => {
    const spec = sampleSpec({
      tools: [
        httpTool({ name: "delete_order", method: "DELETE", path: "/orders/{id}", readOnly: true }),
        {
          name: "run_command",
          description: "Runs any command. Use it for anything. Returns the output.",
          kind: "shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string", description: "The command to run" } }, required: ["cmd"] },
          shell: { command: "sh -c {{cmd}}" },
          readOnly: false,
          destructive: false,
          requiresApproval: false,
        },
      ],
    });
    const c = checks(spec);
    expect(c).toContain("safety.ungated-action");
    expect(c).toContain("safety.readonly-mutates");
    expect(c).toContain("safety.free-form-shell");
  });

  it("flags shouting, bloated and inconsistent system prompts", () => {
    const spec = sampleSpec({ systemPrompt: `You MUST ALWAYS use \`fetch_everything\`. ${"word ".repeat(900)}` });
    const c = checks(spec);
    expect(c).toContain("prompt.shouting");
    expect(c).toContain("prompt.length");
    expect(c).toContain("prompt.unknown-tool");
  });

  it("checks project facts in the prompt when a profile is given", () => {
    const spec = sampleSpec({ systemPrompt: "You are a helpful agent. Use the tools well and be careful with secrets. ".repeat(10) });
    const c = scoreHarness(spec, sampleProfile()).findings.map((f) => f.check);
    expect(c).toEqual(expect.arrayContaining(["prompt.stack", "prompt.base-url", "prompt.auth", "prompt.test-command", "prompt.domain"]));
  });

  it("flags eval gaps: gated coverage, scope, secrets, realism, unknown tools", () => {
    const spec = sampleSpec({
      evals: [
        { id: "a", input: "Please delete order id 123.", expect: { toolsCalled: ["nope"] } },
        { id: "b", input: "How many orders?", expect: { toolsCalled: ["list_orders"] } },
      ],
    });
    const c = checks(spec);
    expect(c).toEqual(expect.arrayContaining(["evals.count", "evals.gated-coverage", "evals.out-of-scope", "evals.secrets", "evals.realism", "evals.unknown-tool"]));
  });

  it("flags subagents on a small surface and subagents holding gated tools", () => {
    const spec = sampleSpec();
    spec.subagents = [{ name: "helper", description: "Helps.", systemPrompt: "Help.", tools: ["cancel_order"] }];
    const c = checks(spec);
    expect(c).toContain("subagents.gated-tool");
    expect(c).toContain("subagents.justified");
    expect(c).toContain("subagents.description");
  });

  it("counts sentences without splitting abbreviations, code, or endpoints", () => {
    expect(sentences("Lists orders (GET /orders/{id}.json). Use it e.g. for `a.b`. Returns JSON.")).toHaveLength(3);
  });

  it("formats a compact report", () => {
    const text = formatQualityReport(scoreHarness(sampleSpec()), 3);
    expect(text).toMatch(/^Harness quality: \d+\/100/);
    expect(text).toMatch(/descriptions \d+/);
  });
});

describe("heuristic planner against the rubric", () => {
  const fixtures = ["express-openapi", "fastapi-app", "go-gin", "nextjs-app"];
  for (const f of fixtures) {
    it(`${f}: scores >= 90 with no errors`, async () => {
      const profile = await scanProject(path.join(FIXTURES, f));
      const spec = planHeuristic(profile, { goal: "", targets: ["typescript"] });
      const r = scoreHarness(spec, profile);
      expect(r.findings.filter((x) => x.severity === "error"), formatQualityReport(r, 20)).toEqual([]);
      expect(r.score, formatQualityReport(r, 20)).toBeGreaterThanOrEqual(90);
    });
  }

  it("a project without an API gets a coding harness with a tailored prompt", () => {
    const profile = sampleProfile({
      name: "hexview",
      description: "A command-line hex viewer",
      apis: [],
      openapiSpecs: [],
      envVars: [],
      database: undefined,
      frameworks: [],
      languages: [{ name: "Rust", files: 10, bytes: 50000 }],
      primaryLanguage: "Rust",
      packageManager: "cargo",
      scripts: [],
      cli: { bin: "hexview", commands: [] },
      keyFiles: [{ path: "src/main.rs", reason: "entrypoint", excerpt: "fn main() {}" }],
    });
    const spec = planHeuristic(profile, { goal: "", targets: ["typescript"] });
    expect(spec.tools.map((t) => t.name)).toEqual(["run_tests", "run_lint", "read_file", "list_files", "search_code", "write_file"]);
    expect(spec.tools.find((t) => t.name === "run_lint")!.shell!.command).toBe("cargo clippy --all-targets");
    expect(spec.systemPrompt).toMatch(/command-line tool \(`hexview`\)/);
    expect(spec.systemPrompt).toMatch(/backward compatible/);
    expect(spec.evals.map((e) => e.id)).toEqual(expect.arrayContaining(["run-tests", "fix-and-verify", "code-grounding", "no-secret-leak", "out-of-scope"]));
    expect(scoreHarness(spec, profile).score).toBeGreaterThanOrEqual(90);
  });
});

describe("heuristic HTTP design details", () => {
  const ep = (method: ApiEndpoint["method"], p: string, extra: Partial<ApiEndpoint> = {}): ApiEndpoint => ({ method, path: p, params: [], source: "app/routes.py:1", ...extra });

  it("resolves name collisions by what differs, not with _2", () => {
    const profile = sampleProfile({
      apis: [
        ep("POST", "/users/", { operationId: "create_user", requestBody: { type: "object", properties: { email: { type: "string" } } } }),
        ep("POST", "/private/users/", { operationId: "create_user", requestBody: { type: "object", properties: { email: { type: "string" } } } }),
      ],
    });
    const names = planHeuristic(profile, { goal: "", targets: ["typescript"] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_user", "create_private_user"]));
    expect(names.some((n) => /_\d+$/.test(n))).toBe(false);
  });

  it("maps handler names and /me routes to CRUD-aware names", () => {
    const profile = sampleProfile({
      apis: [
        ep("GET", "/api/articles", { operationId: "articles_index" }),
        ep("GET", "/api/tags", { operationId: "TagList" }),
        ep("POST", "/api/profiles/{username}/follow", { operationId: "ProfileFollowAPIView" }),
        ep("DELETE", "/api/profiles/{username}/follow", { operationId: "ProfileFollowAPIView" }),
        ep("GET", "/users/me", { operationId: "read_user_me" }),
      ],
    });
    const names = planHeuristic(profile, { goal: "", targets: ["typescript"] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_articles", "list_tags", "follow_profile", "unfollow_profile", "get_current_user"]));
  });

  it("detects login-issued tokens, documents the flow, and leaves the login endpoint out", () => {
    const profile = sampleProfile({
      envVars: [],
      apis: [ep("POST", "/users/login"), ep("GET", "/articles"), ep("GET", "/user")],
    });
    const plan = planHeuristicDetailed(profile, { goal: "", targets: ["typescript"] });
    const { spec } = plan;
    expect(plan.httpDefaults.auth).toEqual({ type: "bearer", env: "ACME_TOKEN" });
    expect(spec.tools.some((t) => t.http?.path === "/users/login")).toBe(false);
    expect(plan.candidateTools.some((t) => t.http?.path === "/users/login")).toBe(true);
    expect(spec.systemPrompt).toMatch(/`POST \/users\/login`/);
    expect(spec.systemPrompt).toMatch(/401/);
    expect(spec.tools.find((t) => t.name === "get_current_user")!.description).toMatch(/ACME_TOKEN/);
    expect(spec.env.find((e) => e.name === "ACME_TOKEN")).toMatchObject({ secret: true, required: false });
    expect(spec.guardrails.redactEnv).toContain("ACME_TOKEN");
  });

  it("drops framework-injected params, cleans regex paths, and explains pagination", () => {
    const profile = sampleProfile({
      apis: [
        ep("GET", "/^api/^items/?$", {
          params: [
            { name: "session", in: "query", required: true, schema: { type: "object", description: "SessionDep" } },
            { name: "skip", in: "query", required: false, schema: { type: "integer" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          ],
        }),
      ],
    });
    const t = planHeuristic(profile, { goal: "", targets: ["typescript"] }).tools.find((x) => x.kind === "http")!;
    expect(t.http!.path).toBe("/api/items/");
    expect(Object.keys(t.inputSchema.properties!)).toEqual(["skip", "limit"]);
    expect(t.inputSchema.properties!.skip!.description).toMatch(/skip.*e\.g\. 0/i);
    expect(t.description).toMatch(/paginated.*`skip` and `limit`/);
  });

  it("treats un-favorite style DELETEs as reversible and describes the pair", () => {
    const profile = sampleProfile({ apis: [ep("POST", "/articles/{slug}/favorite"), ep("DELETE", "/articles/{slug}/favorite"), ep("DELETE", "/articles/{slug}")] });
    const tools = planHeuristic(profile, { goal: "", targets: ["typescript"] }).tools;
    expect(tools.find((t) => t.name === "unfavorite_article")).toMatchObject({ destructive: false, requiresApproval: false });
    expect(tools.find((t) => t.name === "unfavorite_article")!.description).toMatch(/`favorite_article` reverses it/);
    expect(tools.find((t) => t.name === "delete_article")).toMatchObject({ destructive: true, requiresApproval: true });
    expect(tools.find((t) => t.name === "get_article")).toBeUndefined();
  });

  it("gives create tools a body even when the scan could not see one", () => {
    const profile = sampleProfile({ apis: [ep("POST", "/articles", { source: "src/routes/articles.ts:10" })] });
    const t = planHeuristic(profile, { goal: "", targets: ["typescript"] }).tools.find((x) => x.name === "create_article")!;
    expect(t.http!.bodyParam).toBe("body");
    expect(t.inputSchema.required).toContain("body");
    expect(t.inputSchema.properties!.body!.description).toMatch(/src\/routes\/articles\.ts/);
  });

  it("writes evals with concrete values and one restraint case per gated tool", () => {
    const profile = sampleProfile({
      apis: [ep("GET", "/articles"), ep("GET", "/articles/{slug}"), ep("GET", "/articles/{slug}/comments"), ep("DELETE", "/articles/{slug}"), ep("DELETE", "/articles/{slug}/comments/{id}")],
    });
    const spec = planHeuristic(profile, { goal: "", targets: ["typescript"] });
    const inputs = spec.evals.map((e) => e.input).join("\n");
    expect(inputs).toContain('"how-to-train-your-dragon"');
    expect(inputs).not.toMatch(/\b123\b/);
    for (const t of spec.tools.filter((x) => x.requiresApproval)) {
      expect(spec.evals.some((e) => e.expect.toolsNotCalled?.includes(t.name) && /confirm/.test(e.expect.rubric ?? "")), t.name).toBe(true);
    }
    expect(spec.evals.find((e) => e.id === "confirm-before-delete-article-comment")!.input).toMatch(/on the article "how-to-train-your-dragon"/);
  });
});

describe("rubric is shared with the LLM planner", () => {
  it("the critic scores every rubric dimension and both prompts carry the rubric", () => {
    const scores = (CRITIC_SCHEMA.properties as Record<string, { required: string[] }>).scores!;
    expect(scores.required).toEqual(RUBRIC_DIMENSIONS);
    for (const d of RUBRIC_DIMENSIONS) {
      expect(ARCHITECT_SYSTEM).toContain(`- ${d}:`);
      expect(CRITIC_SYSTEM).toContain(`- ${d}:`);
    }
    // Quoted mentions ("MUST") are advice about shouting, not shouting.
    for (const p of [ARCHITECT_SYSTEM, CRITIC_SYSTEM]) expect(p).not.toMatch(/(?<!")\b(MUST|NEVER|CRITICAL|IMPORTANT)\b(?!")/);
  });
});

describe("decree.json JSON schema", () => {
  it("documents every field for editor hovers", () => {
    const missing: string[] = [];
    const walk = (o: Record<string, unknown> | undefined, at: string) => {
      if (!o || typeof o !== "object") return;
      const props = o.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [k, v] of Object.entries(props ?? {})) {
        if (!v.description) missing.push(`${at}.${k}`);
        walk(v, `${at}.${k}`);
      }
      if (o.items) walk(o.items as Record<string, unknown>, `${at}[]`);
    };
    walk(specJsonSchema(), "");
    expect(missing).toEqual([]);
  });
});
