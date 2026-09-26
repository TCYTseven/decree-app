import { describe, expect, it } from "vitest";
import { stringifySpec, specJsonSchema, toKebab, toToolName, validateSpec, DEFAULT_BLOCKED_COMMANDS } from "../src/core/spec.js";
import type { HarnessSpec } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";

function ok(input: unknown) {
  const r = validateSpec(input);
  if (!r.ok) throw new Error("expected ok, got errors:\n" + r.errors.join("\n"));
  return r;
}

function errs(input: unknown): string[] {
  const r = validateSpec(input);
  if (r.ok) throw new Error("expected errors");
  return r.errors;
}

const minimal = { name: "My Agent", systemPrompt: "You help." };

describe("validateSpec: sampleSpec", () => {
  it("round-trips sampleSpec unchanged with no warnings", () => {
    const r = ok(sampleSpec());
    expect(r.spec).toEqual(sampleSpec());
    expect(r.warnings).toEqual([]);
  });

  it("is idempotent", () => {
    const once = ok(sampleSpec({ name: "Weird Name!" })).spec;
    const twice = ok(once);
    expect(twice.spec).toEqual(once);
    expect(twice.warnings).toEqual([]);
  });

  it("survives stringify -> parse -> validate", () => {
    const text = stringifySpec(sampleSpec());
    const back = ok(JSON.parse(text)).spec;
    const { $schema, ...rest } = back;
    expect($schema).toBe("./.decree/schema.json");
    expect(rest).toEqual(sampleSpec());
  });
});

describe("validateSpec: defaults", () => {
  it("fills every default from a minimal spec", () => {
    const { spec } = ok(minimal);
    expect(spec.version).toBe(1);
    expect(spec.name).toBe("my-agent");
    expect(spec.displayName).toBe("My Agent");
    expect(spec.model).toEqual({ id: "claude-opus-5", effort: "high", subagentId: "claude-sonnet-5", thinking: "adaptive" });
    expect(spec.guardrails).toEqual({
      maxTurns: 40,
      maxOutputTokensPerTurn: 32000,
      maxCostUsd: 10,
      blockedCommands: DEFAULT_BLOCKED_COMMANDS,
      allowedPaths: ["."],
      redactEnv: [],
      approvalMode: "destructive",
    });
    expect(spec.guardrails.blockedCommands).toContain("rm -rf /");
    expect(spec.context).toEqual({ caching: true, compaction: true, contextEditing: false, memory: false });
    expect(spec.subagents).toEqual([]);
    expect(spec.evals).toEqual([]);
    expect(spec.tools).toEqual([]);
    expect(spec.targets).toEqual(["typescript", "claude-code"]);
    expect(spec.env).toEqual([{ name: "ANTHROPIC_API_KEY", description: "Anthropic API key", required: true, secret: true }]);
    expect(spec.provenance.generator).toBe("heuristic");
    expect(spec.provenance.profileName).toBe("my-agent");
    expect(() => new Date(spec.provenance.createdAt).toISOString()).not.toThrow();
  });

  it("fills partial nested objects", () => {
    const { spec } = ok({ ...minimal, model: { effort: "max" }, guardrails: { maxTurns: 5 }, context: { memory: true } });
    expect(spec.model).toEqual({ id: "claude-opus-5", effort: "max", subagentId: "claude-sonnet-5", thinking: "adaptive" });
    expect(spec.guardrails.maxTurns).toBe(5);
    expect(spec.guardrails.maxCostUsd).toBe(10);
    expect(spec.guardrails.approvalMode).toBe("destructive");
    expect(spec.context.memory).toBe(true);
    expect(spec.context.caching).toBe(true);
  });

  it("fills kind-based tool defaults (fs root, fs schemas, readOnly)", () => {
    const { spec } = ok({ ...minimal, tools: [{ name: "read", kind: "read_file", description: "Read" }] });
    const t = spec.tools[0]!;
    expect(t.fs).toEqual({ root: "." });
    expect(t.readOnly).toBe(true);
    expect(t.destructive).toBe(false);
    expect(t.inputSchema).toMatchObject({ type: "object", required: ["path"] });
  });
});

describe("validateSpec: normalization", () => {
  it("slugs names and snake_cases tool names, deduping with _2", () => {
    const { spec, warnings } = ok({
      ...minimal,
      tools: [
        { name: "getUser", kind: "shell", description: "a", shell: { command: "echo 1" } },
        { name: "get user", kind: "shell", description: "b", shell: { command: "echo 2" } },
        { name: "get_user", kind: "shell", description: "c", shell: { command: "echo 3" } },
        { name: "x".repeat(80), kind: "shell", description: "d", shell: { command: "echo" } },
        { name: "!!!", kind: "shell", description: "e", shell: { command: "echo" } },
      ],
    });
    expect(spec.tools.map((t) => t.name)).toEqual(["get_user", "get_user_2", "get_user_3", "x".repeat(64), "tool"]);
    for (const t of spec.tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(warnings.some((w) => w.includes('renamed "get user" -> "get_user_2"'))).toBe(true);
  });

  it("dedupes subagents, remaps renamed tool refs and drops unknown refs", () => {
    const { spec, warnings } = ok({
      ...minimal,
      tools: [{ name: "runTests", kind: "shell", description: "t", shell: { command: "npm test" } }],
      subagents: [
        { name: "Test Triager", systemPrompt: "x", tools: ["runTests", "ghost", "run_tests"] },
        { name: "test-triager", systemPrompt: "y", tools: [] },
      ],
    });
    expect(spec.subagents.map((s) => s.name)).toEqual(["test-triager", "test-triager-2"]);
    expect(spec.subagents[0]!.tools).toEqual(["run_tests"]);
    expect(warnings.some((w) => w.includes('unknown tool "ghost" dropped'))).toBe(true);
  });

  it("dedupes eval ids and remaps tool refs", () => {
    const { spec } = ok({
      ...minimal,
      tools: [{ name: "listOrders", kind: "shell", description: "t", shell: { command: "x" } }],
      evals: [
        { id: "a", input: "q", expect: { toolsCalled: ["listOrders"] } },
        { id: "a", input: "q2" },
      ],
    });
    expect(spec.evals.map((e) => e.id)).toEqual(["a", "a-2"]);
    expect(spec.evals[0]!.expect.toolsCalled).toEqual(["list_orders"]);
    expect(spec.evals[1]!.expect).toEqual({});
  });

  it("forces approval on destructive tools", () => {
    const { spec, warnings } = ok({
      ...minimal,
      tools: [{ name: "nuke", kind: "shell", description: "d", shell: { command: "x" }, destructive: true, requiresApproval: false, readOnly: true }],
    });
    expect(spec.tools[0]).toMatchObject({ destructive: true, requiresApproval: true, readOnly: false });
    expect(warnings.some((w) => w.includes("requires approval"))).toBe(true);
  });

  it("coerces empty custom inputSchema and empties server tool schemas", () => {
    const { spec } = ok({
      ...minimal,
      tools: [
        { name: "s", kind: "shell", description: "d", shell: { command: "echo" }, inputSchema: {} },
        { name: "search the web", kind: "web_search", description: "w", inputSchema: { type: "object", properties: { q: {} } } },
        { name: "notes", kind: "memory", description: "m" },
      ],
    });
    expect(spec.tools[0]!.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
    expect(spec.tools[1]).toMatchObject({ name: "web_search", inputSchema: {}, readOnly: true });
    expect(spec.tools[2]).toMatchObject({ name: "memory", inputSchema: {} });
    expect(spec.context.memory).toBe(true);
  });

  it("adds missing path/command params to input schemas and drops unknown required", () => {
    const { spec } = ok({
      ...minimal,
      tools: [
        {
          name: "get",
          kind: "http",
          description: "g",
          http: { method: "get", baseUrlEnv: "API_URL", path: "users/{id}" },
          inputSchema: { type: "object", properties: {}, required: ["nope"] },
        },
        { name: "sh", kind: "shell", description: "s", shell: { command: "grep {{ pattern }} ." } },
      ],
    });
    expect(spec.tools[0]!.http).toMatchObject({ method: "GET", path: "/users/{id}" });
    expect(spec.tools[0]!.inputSchema).toEqual({ type: "object", properties: { id: { type: "string", description: "Path parameter id" } }, required: ["id"] });
    expect(spec.tools[1]!.inputSchema.properties).toHaveProperty("pattern");
    expect(spec.tools[1]!.inputSchema.required).toEqual([]);
  });

  it("auto-adds env vars referenced by http tools and always includes ANTHROPIC_API_KEY", () => {
    const { spec } = ok({
      ...minimal,
      env: [{ name: "EXISTING", description: "e" }],
      tools: [
        { name: "a", kind: "http", description: "a", http: { method: "GET", baseUrlEnv: "SVC_URL", defaultBaseUrl: "http://localhost:1", path: "/a", auth: { type: "header", env: "SVC_KEY", header: "X-Key" } } },
        { name: "b", kind: "http", description: "b", http: { method: "GET", baseUrlEnv: "OTHER_URL", path: "/b" } },
        { name: "c", kind: "http", description: "c", http: { method: "DELETE", path: "/c" } },
      ],
    });
    const byName = Object.fromEntries(spec.env.map((e) => [e.name, e]));
    expect(spec.env[0]!.name).toBe("ANTHROPIC_API_KEY");
    expect(byName.EXISTING).toEqual({ name: "EXISTING", description: "e", required: false, secret: false });
    expect(byName.SVC_URL).toMatchObject({ required: false, secret: false, default: "http://localhost:1" });
    expect(byName.SVC_KEY).toMatchObject({ required: true, secret: true });
    expect(byName.OTHER_URL).toMatchObject({ required: true, secret: false });
    expect(spec.tools[2]!.http!.baseUrlEnv).toBe("MY_AGENT_BASE_URL");
    expect(byName.MY_AGENT_BASE_URL).toBeDefined();
    // DELETE defaults to destructive + approval
    expect(spec.tools[2]).toMatchObject({ destructive: true, requiresApproval: true });
  });

  it("warns about unknown top-level fields", () => {
    const { warnings } = ok({ ...minimal, bogus: 1 });
    expect(warnings).toContain('Unknown field "bogus" ignored.');
  });
});

describe("validateSpec: errors", () => {
  it("rejects non-objects", () => {
    expect(errs(null)[0]).toMatch(/expected a JSON object/);
    expect(errs("hello")[0]).toMatch(/expected a JSON object/);
    expect(errs([1, 2])[0]).toMatch(/array/);
  });

  it("reports readable paths", () => {
    const e = errs({
      name: "x",
      systemPrompt: "y",
      tools: [
        { name: "ok", kind: "shell", description: "", shell: { command: "x" } },
        { name: "a", kind: "shell", description: "" },
        { name: "b", kind: "http", description: "", http: { method: "GET" } },
        { name: "c", kind: "teleport" },
      ],
      model: { effort: "extreme" },
    });
    expect(e).toContain("tools[2].http.path: Required");
    expect(e.some((m) => m.startsWith("tools[3].kind:"))).toBe(true);
    expect(e.some((m) => m.startsWith("model.effort:"))).toBe(true);
  });

  it("reports missing bindings and bad schemas", () => {
    const e = errs({
      ...minimal,
      tools: [
        { name: "a", kind: "shell", description: "" },
        { name: "b", kind: "http", description: "" },
        { name: "c", kind: "shell", description: "", shell: { command: "x" }, inputSchema: { type: "string" } },
        { name: "d", kind: "http", description: "", http: { method: "GET", path: "/", auth: { type: "bearer" } } },
      ],
    });
    expect(e).toContain('tools[0].shell: Required for kind "shell"');
    expect(e).toContain('tools[1].http: Required for kind "http"');
    expect(e.some((m) => m.startsWith("tools[2].inputSchema.type"))).toBe(true);
    expect(e.some((m) => m.startsWith("tools[3].http.auth.env"))).toBe(true);
  });

  it("requires name and systemPrompt", () => {
    const e = errs({ tools: [] });
    expect(e).toContain("name: Required");
    expect(e).toContain("systemPrompt: Required");
  });
});

describe("toKebab / toToolName", () => {
  it("normalizes", () => {
    expect(toKebab("Acme  Ops_Agent!")).toBe("acme-ops-agent");
    expect(toKebab("myCoolAgent")).toBe("my-cool-agent");
    expect(toKebab("")).toBe("agent");
    expect(toToolName("GET /users/{id}")).toBe("get_users_id");
    expect(toToolName("listOrders")).toBe("list_orders");
  });
});

describe("stringifySpec", () => {
  it("puts $schema first, uses canonical order, 2-space indent, trailing newline", () => {
    const spec = sampleSpec();
    // scramble top-level key order
    const scrambled = Object.fromEntries(Object.entries(spec).reverse()) as unknown as HarnessSpec;
    const text = stringifySpec(scrambled);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "$schema": "./.decree/schema.json",\n  "version": 1,\n  "name": "acme-ops-agent"')).toBe(true);
    expect(text).toBe(stringifySpec(spec));
    const tool = JSON.parse(text).tools[0];
    expect(Object.keys(tool).slice(0, 4)).toEqual(["name", "description", "kind", "inputSchema"]);
    expect(text).not.toContain("bodyParam");
  });
});

describe("specJsonSchema", () => {
  it("produces an object schema describing decree.json", () => {
    const s = specJsonSchema() as any;
    expect(s.type).toBe("object");
    expect(s.title).toBe("decree.json");
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["name", "tools", "guardrails", "model", "$schema"]));
    expect(s.required).toEqual(expect.arrayContaining(["name", "systemPrompt"]));
    expect(s.required).not.toContain("tools");
    expect(s.properties.tools.items.properties.kind.enum).toContain("http");
    expect(() => JSON.stringify(s)).not.toThrow();
  });
});
