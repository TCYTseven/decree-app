import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/core/types.js";
import { validateSpec, stringifySpec } from "../src/core/spec.js";
import { extractDecisions, isRuleText, statusFromText } from "../src/decisions/extract.js";
import { globMatches, globSpecificity, normalizeRepoPath } from "../src/decisions/glob.js";
import { mergeDecisions } from "../src/decisions/merge.js";
import { formatDecisions, rankDecisions, runGetDecisions, scopeDecisions } from "../src/decisions/scope.js";
import { DECISIONS_TOOL_NAME, withDecisions, withDecisionsPromptLine, withoutDecisionsPromptLine } from "../src/decisions/tool.js";
import { planHeuristic } from "../src/planner/heuristic.js";
import { executeTool } from "../src/runtime/tools/index.js";
import { scanProject } from "../src/scanner/index.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

const FIXTURE = path.resolve("test/fixtures/decisions-repo");

const d = (id: string, status: Decision["status"], governs: string[], extra: Partial<Decision> = {}): Decision => ({
  id,
  title: `Title ${id}`,
  constraint: `Rule for ${id}.`,
  status,
  governs,
  source: `docs/${id}.md`,
  ...extra,
});

describe("glob matcher", () => {
  const cases: [string, string, boolean][] = [
    ["**", "anything/at/all.ts", true],
    ["**", "", true],
    ["src/**", "src", true],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/a/b/c.tsx", false],
    ["**/*.sql", "migrations/001.sql", true],
    ["**/*.sql", "001.sql", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/?.ts", "src//.ts", false],
    ["src/*.{ts,tsx}", "src/a.tsx", true],
    ["src/*.{ts,tsx}", "src/a.js", false],
    ["src/db", "src/db", true],
    ["src/db", "src/db/users.ts", true],
    ["src/db", "src/dbx/users.ts", false],
    ["CLAUDE.md", "CLAUDE.md", true],
    ["./src//db/", "src/db/x.ts", true],
    ["src\\db\\**", "src/db/x.ts", true],
    ["src/db/**", "./src\\db\\x.ts", true],
    ["src/db/**", "src", true], // a directory that holds what the glob names
    ["src/db/**", "src/d", false],
    ["src/db/**", ".", true],
    ["a.b/**", "axb/c", false], // dots are literal
    ["src/(x)/**", "src/(x)/y", true],
    ["src/[ab].ts", "src/[ab].ts", true], // brackets are literal
    ["src/[ab].ts", "src/a.ts", false],
  ];
  for (const [glob, p, want] of cases) {
    it(`${glob} ${want ? "matches" : "does not match"} "${p}"`, () => expect(globMatches(glob, p)).toBe(want));
  }

  it("normalizes paths and ranks globs by their literal prefix", () => {
    expect(normalizeRepoPath("./src//db\\users.ts/")).toBe("src/db/users.ts");
    expect(normalizeRepoPath(".")).toBe("");
    expect(globSpecificity("**")).toBe(0);
    expect(globSpecificity("src/**")).toBe(3);
    expect(globSpecificity("src/db/**")).toBe(6);
    expect(globSpecificity("src/db/users.ts")).toBe(15);
    expect(globSpecificity("")).toBe(0);
  });
});

describe("scoped retrieval", () => {
  const all = [
    d("repo", "live", ["**"]),
    d("src", "live", ["src/**"]),
    d("db", "live", ["src/db/**"]),
    d("users-file", "live", ["src/db/users.ts"]),
    d("draft-db", "proposed", ["src/db/**"]),
    d("old-db", "superseded", ["src/db/**"], { supersededBy: "db" }),
    d("api", "live", ["src/api/**"]),
  ];

  it("returns live decisions that govern the paths, most specific first, repo-wide last", () => {
    expect(scopeDecisions(all, ["src/db/users.ts"]).map((x) => x.id)).toEqual(["users-file", "db", "src", "repo"]);
    expect(scopeDecisions(all, ["src/api/x.ts"]).map((x) => x.id)).toEqual(["api", "src", "repo"]);
    expect(scopeDecisions(all, ["README.md"]).map((x) => x.id)).toEqual(["repo"]);
  });

  it("serves proposed decisions only when asked, and superseded ones never", () => {
    expect(scopeDecisions(all, ["src/db/a.ts"]).map((x) => x.id)).not.toContain("draft-db");
    const withProposed = scopeDecisions(all, ["src/db/a.ts"], { includeProposed: true }).map((x) => x.id);
    expect(withProposed).toEqual(["db", "draft-db", "src", "repo"]); // live before proposed at the same specificity
    expect(withProposed).not.toContain("old-db");
  });

  it("merges several paths and caps at the limit (default 8)", () => {
    expect(scopeDecisions(all, ["src/db/users.ts", "src/api/x.ts"]).map((x) => x.id)).toEqual(["users-file", "api", "db", "src", "repo"]);
    expect(scopeDecisions(all, ["src/db/users.ts"], { limit: 2 }).map((x) => x.id)).toEqual(["users-file", "db"]);
    const many = Array.from({ length: 12 }, (_, i) => d(`r${i}`, "live", ["**"]));
    expect(scopeDecisions(many, ["x"])).toHaveLength(8);
    expect(scopeDecisions(many, ["x"], { limit: 0 })).toHaveLength(8);
  });

  it("a directory path picks up decisions for what is inside it", () => {
    expect(scopeDecisions(all, ["src"]).map((x) => x.id)).toEqual(["users-file", "api", "db", "src", "repo"]);
    expect(rankDecisions(all, ["."]).length).toBe(5);
  });

  it("formats compact text with id, title, rule, scope and source", () => {
    const text = formatDecisions(scopeDecisions(all, ["src/db/users.ts"], { limit: 2 }), { total: 4, limit: 2 });
    expect(text).toContain("[users-file] Title users-file\nRule: Rule for users-file.\nGoverns: src/db/users.ts | Source: docs/users-file.md");
    expect(text).toContain("2 more matched but were left out (limit 2)");
    expect(formatDecisions([])).toBe("No live decisions govern these paths.");
    expect(formatDecisions([], { includeProposed: true })).toBe("No live or proposed decisions govern these paths.");
  });

  it("the tool validates input and makes absolute paths repo-relative", () => {
    expect(runGetDecisions(all, {}).isError).toBe(true);
    expect(runGetDecisions(all, { paths: [] }).isError).toBe(true);
    expect(runGetDecisions(all, { paths: [1] }).isError).toBe(true);
    const abs = runGetDecisions(all, { paths: [path.join("/repo", "src", "db", "users.ts")] }, "/repo");
    expect(abs.output).toMatch(/^4 decisions govern/);
    expect(abs.output.indexOf("[users-file]")).toBeLessThan(abs.output.indexOf("[repo]"));
    expect(runGetDecisions(all, { paths: "src/api/x.ts" }).output).toContain("[api]");
  });
});

describe("extraction", () => {
  it("reads ADRs, rules files and post-mortems from the fixture", async () => {
    const { decisions, sources } = await extractDecisions(FIXTURE);
    const byId = new Map(decisions.map((x) => [x.id, x]));
    expect(sources).toEqual([
      "docs/adr/0001-use-postgres.md",
      "docs/adr/0002-use-mongodb-for-events.md",
      "docs/adr/0003-store-events-in-postgres.md",
      "CLAUDE.md",
      ".cursor/rules/api.mdc",
      "services/billing/AGENTS.md",
      "docs/postmortems/2026-03-12-duplicate-charges.md",
    ]);

    // ADRs: title without the "ADR-0001:" prefix, status, frontmatter governs, Decision and Context sections.
    const pg = byId.get("adr-0001-use-postgres")!;
    expect(pg).toMatchObject({ title: "Use Postgres for all persistent data", status: "live", governs: ["src/db/**", "migrations/**"], source: "docs/adr/0001-use-postgres.md" });
    expect(pg.constraint).toMatch(/^All persistent data lives in Postgres/);
    expect(pg.rationale).toMatch(/^We run one service/);
    // "Superseded by [ADR-0003](...)" resolves to the id; "Supersedes" on the newer one agrees.
    expect(byId.get("adr-0002-use-mongodb-for-events")).toMatchObject({ status: "superseded", supersededBy: "adr-0003-store-events-in-postgres", owner: "platform team" });
    const events = byId.get("adr-0003-store-events-in-postgres")!;
    expect(events).toMatchObject({ status: "live", owner: "@ledger-team" });
    expect(events.constraint).toBe("Write domain events to the `events` table in the same Postgres transaction as the change they describe. Never publish an event before its transaction commits.");

    // CLAUDE.md: imperative bullets become proposed decisions; governs comes from paths the rule mentions.
    const sql = byId.get("rule-claude-md-never-write-raw-sql-outside-src")!;
    expect(sql).toMatchObject({ status: "proposed", governs: ["src/db/**"], source: "CLAUDE.md:7" });
    expect(byId.get("rule-claude-md-never-edit-files-in-migrations-that")?.governs).toEqual(["migrations/**"]);
    expect(byId.get("rule-claude-md-always-run-npm-test-before-you")?.governs).toEqual(["**"]);
    expect(decisions.some((x) => /lives in `src\/api`/.test(x.constraint))).toBe(false); // a fact, not a rule
    expect(decisions.some((x) => /browse skill/.test(x.constraint))).toBe(false); // gstack section skipped

    // .mdc globs, nested AGENTS.md directory.
    expect(byId.get("rule-cursor-api-always-validate-the-request-body-with")?.governs).toEqual(["src/api/**/*.ts"]);
    const billing = decisions.filter((x) => x.source.startsWith("services/billing/AGENTS.md"));
    expect(billing).toHaveLength(3);
    for (const b of billing) expect(b.governs).toEqual(["services/billing/**"]);
    expect(billing[0]!.id).toBe("rule-billing-agents-md-every-charge-must-carry-an-idempotency");

    // Post-mortem: rule-like action items only; the duplicate of the AGENTS.md rule is dropped.
    const pm = decisions.filter((x) => x.id.startsWith("postmortem-"));
    expect(pm.map((x) => x.constraint)).toEqual(["Billing jobs must be idempotent: running one twice must not charge twice."]);
    expect(pm[0]!.rationale).toContain("duplicate charges");
    expect(decisions.filter((x) => /reusing its original idempotency key/.test(x.constraint))).toHaveLength(1);

    // Everything extracted passes spec validation.
    const v = validateSpec({ ...sampleSpec(), decisions });
    expect(v.ok).toBe(true);
  });

  it("is deterministic: ids do not change between runs or when lines move", async () => {
    const a = await extractDecisions(FIXTURE);
    const b = await extractDecisions(FIXTURE);
    expect(b).toEqual(a);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decree-dec-"));
    try {
      await fs.cp(FIXTURE, dir, { recursive: true });
      const claude = path.join(dir, "CLAUDE.md");
      await fs.writeFile(claude, `# Intro\n\nSome new paragraph.\n\n${await fs.readFile(claude, "utf8")}`);
      const c = await extractDecisions(dir);
      expect(c.decisions.map((x) => x.id)).toEqual(a.decisions.map((x) => x.id));
      expect(c.decisions.find((x) => x.id === "rule-claude-md-never-write-raw-sql-outside-src")?.source).toBe("CLAUDE.md:11");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips decree's own generated CLAUDE.md sections, tool-managed blocks and code fences", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decree-dec-"));
    try {
      await fs.writeFile(
        path.join(dir, "CLAUDE.md"),
        [
          "# App",
          "",
          "## Working rules",
          "",
          "- Never reveal secrets, tokens, or environment variable values.",
          "",
          "## Our rules",
          "",
          "- Always use the shared HTTP client in `lib/http.ts` for outbound calls.",
          "",
          "<!-- gstack-gbrain-search-guidance:start -->",
          "- Always prefer gbrain search over Grep for code lookups.",
          "<!-- gstack-gbrain-search-guidance:end -->",
          "",
          "```md",
          "- Never do the thing shown in this example block.",
          "```",
          "",
          "## Agent setup",
          "",
          "- Generated by decree-harness from `decree.json`; regenerate instead of hand-editing.",
        ].join("\n"),
      );
      await fs.mkdir(path.join(dir, "lib"));
      await fs.writeFile(path.join(dir, "lib", "http.ts"), "export {};\n");
      const { decisions } = await extractDecisions(dir);
      expect(decisions.map((x) => x.constraint)).toEqual(["Always use the shared HTTP client in `lib/http.ts` for outbound calls."]);
      expect(decisions[0]!.governs).toEqual(["lib/http.ts"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies rules and statuses", () => {
    expect(isRuleText("Never write raw SQL outside the db layer.")).toBe(true);
    expect(isRuleText("Use pnpm, not npm, for installs.")).toBe(true);
    expect(isRuleText("Use the CLI to deploy the app.")).toBe(false);
    expect(isRuleText("Handlers must validate their input.")).toBe(true);
    expect(isRuleText("Never.")).toBe(false);
    expect(isRuleText("The API lives in src/api.")).toBe(false);
    expect(statusFromText("Accepted")).toBe("live");
    expect(statusFromText("**Approved** on 2025-01-02")).toBe("live");
    expect(statusFromText("Draft")).toBe("proposed");
    expect(statusFromText("Superseded by ADR-0007")).toBe("superseded");
    expect(statusFromText("Rejected")).toBe("superseded");
    expect(statusFromText("something else")).toBeUndefined();
  });

  it("the scanner lists decision sources without reading them", async () => {
    const profile = await scanProject(FIXTURE);
    expect(profile.decisionSources).toContain("docs/adr/0001-use-postgres.md");
    expect(profile.decisionSources).toContain("services/billing/AGENTS.md");
    const plain = await scanProject(path.resolve("test/fixtures/go-gin"));
    expect(plain.decisionSources).toBeUndefined();
  });
});

describe("merge on re-run", () => {
  it("keeps existing decisions and statuses, appends new ones, and reports missing sources", () => {
    const existing = [
      d("adr-1", "live", ["src/**"], { source: "docs/adr/0001-x.md" }),
      d("rule-claude-md-a", "live", ["**"], { source: "CLAUDE.md:3", constraint: "Never do A in this repo." }),
      d("rule-claude-md-gone", "proposed", ["**"], { source: "CLAUDE.md:9", constraint: "Never do B anywhere." }),
      d("adr-deleted", "live", ["**"], { source: "docs/adr/0009-deleted.md" }),
      d("from-a-meeting", "live", ["**"], { source: "team sync 2026-01-10" }),
    ];
    const extracted = [
      d("adr-1", "proposed", ["**"], { source: "docs/adr/0001-x.md", title: "Changed title" }),
      d("rule-claude-md-a", "proposed", ["**"], { source: "CLAUDE.md:5", constraint: "Never do A in this repo." }),
      d("rule-claude-md-new", "proposed", ["**"], { source: "CLAUDE.md:7", constraint: "Always do C first." }),
    ];
    const exists = (f: string) => f !== "docs/adr/0009-deleted.md";
    const r = mergeDecisions(existing, extracted, exists);
    expect(r.decisions.map((x) => x.id)).toEqual(["adr-1", "rule-claude-md-a", "rule-claude-md-gone", "adr-deleted", "from-a-meeting", "rule-claude-md-new"]);
    expect(r.decisions[0]).toEqual(existing[0]); // status and text stay as the team left them
    expect(r.decisions[1]).toMatchObject({ status: "live", source: "CLAUDE.md:5" }); // moved line refreshed
    expect(r.added.map((x) => x.id)).toEqual(["rule-claude-md-new"]);
    expect(r.missing.map((m) => [m.decision.id, m.reason])).toEqual([
      ["rule-claude-md-gone", "not-found"],
      ["adr-deleted", "file-gone"],
    ]);
  });
});

describe("spec", () => {
  it("validates decisions: unique ids, known status, supersededBy target, non-empty governs", () => {
    const bad = validateSpec({
      ...sampleSpec(),
      decisions: [d("a", "live", ["**"]), d("a", "live", ["**"]), d("b", "superseded", ["**"], { supersededBy: "nope" }), d("c", "live", []), { ...d("e", "live", ["**"]), status: "maybe" }, d("Bad Id", "live", ["**"])],
    });
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? [] : bad.errors.join("\n");
    expect(errors).toMatch(/decisions\[3\]\.governs/);
    expect(errors).toMatch(/decisions\[4\]\.status/);
    const bad2 = validateSpec({ ...sampleSpec(), decisions: [d("a", "live", ["**"]), d("a", "live", ["**"]), d("b", "superseded", ["**"], { supersededBy: "nope" }), d("Bad Id", "live", ["**"])] });
    expect(bad2.ok).toBe(false);
    const e2 = bad2.ok ? "" : bad2.errors.join("\n");
    expect(e2).toContain('decisions[1].id: duplicate id "a"');
    expect(e2).toContain('decisions[2].supersededBy: no decision has id "nope"');
    expect(e2).toContain('decisions[3].id: "Bad Id" must be a lowercase slug');
  });

  it("warns when a decision names supersededBy but is still live, or a decisions tool has nothing to serve", () => {
    const v = validateSpec({ ...sampleSpec(), decisions: [d("a", "live", ["**"], { supersededBy: "b" }), d("b", "live", ["**"])] });
    expect(v.ok && v.warnings.some((w) => /supersededBy but its status is "live"/.test(w))).toBe(true);
    const t = validateSpec({ ...sampleSpec(), tools: [...sampleSpec().tools, { name: "get_decisions", kind: "decisions", description: "x" }] });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const tool = t.spec.tools.find((x) => x.kind === "decisions")!;
    expect(tool).toMatchObject({ readOnly: true, destructive: false });
    expect(tool.inputSchema.required).toEqual(["paths"]);
    expect(t.warnings.some((w) => /decisions is empty/.test(w))).toBe(true);
  });

  it("specs without decisions load and serialize unchanged", () => {
    const v = validateSpec(sampleSpec());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect("decisions" in v.spec).toBe(false);
    expect(stringifySpec(v.spec)).not.toContain('"decisions"');
    const withD = validateSpec({ ...sampleSpec(), decisions: [d("a", "live", ["src/**", "src/**"])] });
    expect(withD.ok && withD.spec.decisions).toEqual([d("a", "live", ["src/**"])]);
  });

  it("withDecisions adds get_decisions and the prompt line once, and leaves decision-free specs alone", () => {
    const base = sampleSpec();
    expect(withDecisions(base)).toBe(base);
    expect(withDecisions(base, [])).toBe(base);
    const once = withDecisions(base, [d("a", "live", ["**"])]);
    const twice = withDecisions(once);
    expect(twice).toEqual(once);
    expect(once.tools.filter((t) => t.kind === "decisions").map((t) => t.name)).toEqual([DECISIONS_TOOL_NAME]);
    expect(once.tools.at(-1)!.name).toBe(DECISIONS_TOOL_NAME); // appended: the cached tool prefix stays put
    expect(once.systemPrompt.split("get_decisions").length - 1).toBe(1);
    expect(validateSpec(once).ok).toBe(true);
  });

  it("puts the prompt line under How to work, or appends a section", () => {
    expect(withDecisionsPromptLine("# Role\nx\n\n# How to work\n- a\n- b\n")).toMatch(/# How to work\n- Before you change code, call `get_decisions`[^\n]*\n- a\n/);
    expect(withDecisionsPromptLine("Just a prompt.")).toMatch(/Just a prompt\.\n\n# Team decisions\n- Before you change code/);
    for (const p of ["# Role\nx\n\n# How to work\n- a\n- b\n", "Just a prompt.\n"]) expect(withoutDecisionsPromptLine(withDecisionsPromptLine(p))).toBe(p);
  });
});

describe("planner + runtime", () => {
  it("the heuristic planner serves decisions only when there are some", () => {
    const without = planHeuristic(sampleProfile(), { goal: "Fix bugs" });
    expect(without.tools.some((t) => t.kind === "decisions")).toBe(false);
    expect(without.systemPrompt).not.toContain("get_decisions");
    expect("decisions" in without).toBe(false);
    const withD = planHeuristic(sampleProfile(), { goal: "Fix bugs", decisions: [d("a", "live", ["**"])] });
    expect(withD.tools.at(-1)).toMatchObject({ name: "get_decisions", kind: "decisions", readOnly: true });
    expect(withD.systemPrompt).toContain("call `get_decisions`");
    expect(withD.decisions).toHaveLength(1);
    expect(withD.provenance.notes?.some((n) => /get_decisions/.test(n))).toBe(true);
  });

  it("the runtime tool reads decisions from the loaded spec, also in dry-run mode", async () => {
    const spec = withDecisions(sampleSpec(), [d("db", "live", ["src/db/**"]), d("draft", "proposed", ["src/**"])]);
    const tool = spec.tools.find((t) => t.kind === "decisions")!;
    const ctx = { projectRoot: "/repo", spec, dryRun: true };
    const out = await executeTool(tool, { paths: ["src/db/x.ts"] }, ctx);
    expect(out).toEqual({ isError: false, output: expect.stringContaining("[db] Title db") });
    expect(out.output).not.toContain("[draft]");
    expect((await executeTool(tool, { paths: ["src/db/x.ts"], include_proposed: true }, ctx)).output).toContain("[draft]");
    expect((await executeTool(tool, { paths: "nope" }, ctx)).isError).toBe(true); // schema says array
  });
});

describe("fixture copies", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "decree-dec-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips decree's generated output directory", async () => {
    await fs.cp(FIXTURE, dir, { recursive: true });
    await fs.mkdir(path.join(dir, "agent", "claude-code"), { recursive: true });
    await fs.writeFile(path.join(dir, "agent", ".decree-generated"), "x");
    await fs.writeFile(path.join(dir, "agent", "claude-code", "CLAUDE.md"), "- Never do anything the generated file says.\n");
    const { sources } = await extractDecisions(dir);
    expect(sources.some((s) => s.startsWith("agent/"))).toBe(false);
  });
});
