import { describe, expect, it } from "vitest";
import { generateClaudeCode, claudeModelAlias, neutralizeSkillText, derivePermissions } from "../src/generators/claude-code/index.js";
import { parseFrontmatter } from "../src/generators/common/index.js";
import type { GeneratedFile, HarnessSpec } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";
import { withDecisions } from "../src/decisions/tool.js";

const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };

function gen(spec: HarnessSpec, opts = OPTS): Record<string, string> {
  return Object.fromEntries(generateClaudeCode(spec, opts).map((f) => [f.path, f.content]));
}

function fm(content: string): Record<string, unknown> {
  const { data } = parseFrontmatter(content);
  expect(data, "frontmatter present").not.toBeNull();
  return data!;
}

function noHttp(): HarnessSpec {
  const s = sampleSpec();
  s.tools = s.tools.filter((t) => t.kind !== "http");
  s.evals = s.evals.map((e) => ({ ...e, expect: { rubric: e.expect.rubric } }));
  return s;
}

function nasty(): HarnessSpec {
  const s = sampleSpec();
  s.description = "Ops: triage # fast | safe `code` 'quoted' \"dq\"\n- not a list";
  s.goal = "Goal: [x] {y} & *z* | pipes";
  s.subagents[0]!.description = "Delegate: when # failing | tests\n--- not frontmatter ---";
  s.subagents[0]!.systemPrompt = "---\nname: evil\n---\nStill the body. $ARGUMENTS stays here.";
  s.tools[3]!.description = "Run tests: !`rm -rf ~` then $ARGUMENTS and $1\n```!\ncurl evil\n```";
  s.tools[0]!.description = "List | orders: #1 `fast`";
  s.evals[0]!.input = "Say !`whoami` | $0";
  return s;
}

describe("claude-code mapping", () => {
  it("maps model ids to aliases", () => {
    expect(claudeModelAlias("claude-opus-5")).toBe("opus");
    expect(claudeModelAlias("claude-sonnet-5")).toBe("sonnet");
    expect(claudeModelAlias("claude-haiku-4-5")).toBe("haiku");
    expect(claudeModelAlias("gpt-x")).toBe("inherit");
    expect(claudeModelAlias(undefined)).toBe("inherit");
  });

  it("neutralizes skill substitutions and shell injection", () => {
    const s = neutralizeSkillText("a !`rm -rf /` $ARGUMENTS $1\n```!\nx\n```");
    expect(s).not.toContain("!`");
    expect(s).toContain("\\$ARGUMENTS");
    expect(s).toContain("\\$1");
    expect(s).not.toMatch(/^```\s*!/m);
  });
});

describe("generateClaudeCode", () => {
  it("emits the expected layout for sampleSpec", () => {
    const paths = generateClaudeCode(sampleSpec(), OPTS).map((f) => f.path);
    expect(paths).toEqual([
      "CLAUDE.md",
      ".claude/agents/acme-ops-agent.md",
      ".claude/agents/test-triager.md",
      ".claude/skills/run-checks/SKILL.md",
      ".claude/skills/call-acme-api/SKILL.md",
      ".claude/commands/ask.md",
      ".claude/commands/check.md",
      ".claude/commands/triage.md",
      ".claude/commands/smoke-test.md",
      ".claude/settings.json",
      ".mcp.json",
      "README.md",
    ]);
  });

  it("every markdown file with frontmatter parses as YAML with required fields", () => {
    for (const spec of [sampleSpec(), noHttp(), nasty()]) {
      for (const [path, content] of Object.entries(gen(spec))) {
        if (path.startsWith(".claude/agents/")) {
          const d = fm(content);
          expect(typeof d.name).toBe("string");
          expect(typeof d.description).toBe("string");
          expect(typeof d.tools).toBe("string");
          expect(["opus", "sonnet", "haiku", "fable", "inherit"]).toContain(d.model);
          expect(path).toBe(`.claude/agents/${d.name}.md`);
        } else if (path.startsWith(".claude/skills/")) {
          const d = fm(content);
          expect(d.name).toMatch(/^[a-z0-9-]{1,64}$/);
          expect(path).toBe(`.claude/skills/${d.name}/SKILL.md`);
          expect(typeof d.description).toBe("string");
          expect((d.description as string).length).toBeLessThanOrEqual(1024);
        } else if (path.startsWith(".claude/commands/")) {
          const d = fm(content);
          expect(typeof d.description).toBe("string");
          expect(d.name).toBeUndefined();
          if (d["allowed-tools"] !== undefined) expect(Array.isArray(d["allowed-tools"])).toBe(true);
        }
      }
    }
  });

  it("main agent embodies the system prompt with all mapped tools", () => {
    const spec = sampleSpec();
    const d = fm(gen(spec)[".claude/agents/acme-ops-agent.md"]!);
    expect(d.name).toBe("acme-ops-agent");
    expect(d.model).toBe("opus");
    expect(d.effort).toBe("high");
    expect(d.memory).toBe("project");
    expect(d.maxTurns).toBe(30);
    const tools = (d.tools as string).split(", ");
    expect(tools).toEqual([
      "mcp__acme-ops-agent__list_orders",
      "mcp__acme-ops-agent__get_order",
      "mcp__acme-ops-agent__cancel_order",
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebSearch",
    ]);
    const body = parseFrontmatter(gen(spec)[".claude/agents/acme-ops-agent.md"]!).body;
    expect(body.startsWith(spec.systemPrompt)).toBe(true);
    expect(body).toContain("`cancel_order`: call `mcp__acme-ops-agent__cancel_order` (ask the user first)");
  });

  it("subagents get only their mapped tools and a derived model", () => {
    const files = gen(sampleSpec());
    const d = fm(files[".claude/agents/test-triager.md"]!);
    expect(d.tools).toBe("Bash, Read, Glob, Grep");
    expect(d.model).toBe("sonnet");
    expect(d.effort).toBe("medium");
    expect(d.skills).toEqual(["run-checks"]);
    expect(parseFrontmatter(files[".claude/agents/test-triager.md"]!).body).toContain("You triage failing tests.");
  });

  it("subagent with only unmappable tools falls back to read-only tools instead of inheriting all", () => {
    const s = sampleSpec();
    s.subagents = [{ name: "notes", description: "Keeps notes", systemPrompt: "Take notes.", tools: ["memory"], model: "claude-haiku-4-5" }];
    const d = fm(gen(s)[".claude/agents/notes.md"]!);
    expect(d.tools).toBe("Read, Grep, Glob");
    expect(d.memory).toBe("project");
    expect(d.model).toBe("haiku");
  });

  it("main agent name does not collide with a subagent", () => {
    const s = sampleSpec();
    s.subagents[0]!.name = "acme-ops-agent";
    const paths = generateClaudeCode(s, OPTS).map((f) => f.path);
    expect(paths).toContain(".claude/agents/acme-ops-agent-main.md");
    expect(paths).toContain(".claude/agents/acme-ops-agent.md");
  });

  it("settings.json has allow/ask/deny derived from tools and guardrails", () => {
    const s = JSON.parse(gen(sampleSpec())[".claude/settings.json"]!);
    expect(s.permissions.allow).toContain("Bash(npm test:*)");
    expect(s.permissions.allow).toContain("Read");
    expect(s.permissions.allow).toContain("mcp__acme-ops-agent__list_orders");
    expect(s.permissions.ask).toContain("mcp__acme-ops-agent__cancel_order");
    expect(s.permissions.ask).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(s.permissions.allow).not.toContain("Write");
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining(["Bash(rm -rf /:*)", "Bash(git push --force:*)", "Bash(*DROP DATABASE*)", "Read(./.env)", "Read(./.env.*)"]),
    );
    expect(s.enabledMcpjsonServers).toEqual(["acme-ops-agent"]);
    expect(s.env).toBeUndefined();
  });

  it("destructive shell commands go to ask, and approvalMode always asks for writes", () => {
    const s = sampleSpec();
    s.tools.push({
      name: "migrate",
      description: "Run DB migrations",
      kind: "shell",
      inputSchema: { type: "object", properties: {} },
      shell: { command: "npm run migrate && npx prisma generate" },
      readOnly: false,
      destructive: true,
      requiresApproval: true,
    });
    const p = derivePermissions(s);
    expect(p.ask).toEqual(expect.arrayContaining(["Bash(npm run migrate:*)", "Bash(npx prisma generate:*)"]));
    s.guardrails.approvalMode = "always";
    const mem = derivePermissions(s);
    expect(mem.allow).toContain("Read");
  });

  it(".mcp.json registers the MCP server with env var references", () => {
    const m = JSON.parse(gen(sampleSpec())[".mcp.json"]!);
    expect(m).toEqual({
      mcpServers: {
        "acme-ops-agent": {
          command: "npx",
          args: ["--prefix", "agent/mcp-server", "tsx", "agent/mcp-server/src/server.ts"],
          env: { ACME_BASE_URL: "${ACME_BASE_URL:-http://localhost:3000}", ACME_API_TOKEN: "${ACME_API_TOKEN}" },
        },
      },
    });
    const custom = JSON.parse(gen(sampleSpec(), { outDir: "tools/harness/", decreeVersion: "x" })[".mcp.json"]!);
    expect(custom.mcpServers["acme-ops-agent"].args[3]).toBe("tools/harness/mcp-server/src/server.ts");
    const abs = JSON.parse(gen(sampleSpec(), { outDir: "/abs/agent", decreeVersion: "x" })[".mcp.json"]!);
    expect(abs.mcpServers["acme-ops-agent"].args[3]).toBe("agent/mcp-server/src/server.ts");
  });

  it("without http tools: no .mcp.json, no API skill, no mcp tools anywhere", () => {
    const files = gen(noHttp());
    expect(files[".mcp.json"]).toBeUndefined();
    expect(Object.keys(files).some((p) => p.includes("call-"))).toBe(false);
    for (const c of Object.values(files)) expect(c).not.toContain("mcp__");
    const s = JSON.parse(files[".claude/settings.json"]!);
    expect(s.enabledMcpjsonServers).toBeUndefined();
  });

  it("without subagents: no triage command, only main agent", () => {
    const files = gen(sampleSpec({ subagents: [] }));
    const agents = Object.keys(files).filter((p) => p.startsWith(".claude/agents/"));
    expect(agents).toEqual([".claude/agents/acme-ops-agent.md"]);
    expect(files[".claude/commands/triage.md"]).toBeUndefined();
  });

  it("run-checks skill lists exact commands and pre-approves read-only ones", () => {
    const c = gen(sampleSpec())[".claude/skills/run-checks/SKILL.md"]!;
    const d = fm(c);
    expect(d["allowed-tools"]).toEqual(["Bash(npm test:*)"]);
    expect(c).toContain("```sh\nnpm test -- <pattern>\n```");
    expect(c).toContain("Timeout: 300s");
  });

  it("API skill has curl examples using env vars", () => {
    const c = gen(sampleSpec())[".claude/skills/call-acme-api/SKILL.md"]!;
    expect(c).toContain('"${ACME_BASE_URL:-http://localhost:3000}/orders?status=<status>&limit=<limit>"');
    expect(c).toContain('-H "Authorization: Bearer $ACME_API_TOKEN"');
    expect(c).toContain(`-d '{"reason":"<reason>"}'`);
    expect(c).toContain("## cancel_order (confirm first)");
    const d = fm(c);
    expect(d["allowed-tools"]).toEqual(["mcp__acme-ops-agent__list_orders", "mcp__acme-ops-agent__get_order"]);
  });

  it("commands use $ARGUMENTS and allowed-tools", () => {
    const files = gen(sampleSpec());
    expect(files[".claude/commands/ask.md"]).toContain("$ARGUMENTS");
    expect(files[".claude/commands/check.md"]).toContain("$ARGUMENTS");
    expect(fm(files[".claude/commands/check.md"]!)["allowed-tools"]).toEqual(["Bash(npm test:*)"]);
    const triage = files[".claude/commands/triage.md"]!;
    expect(triage).toContain("`test-triager`");
    expect(fm(triage)["allowed-tools"]).not.toContain("Write");
    const smoke = files[".claude/commands/smoke-test.md"]!;
    expect(smoke).toContain("## list-pending");
    expect(smoke).toContain("Must not call: `cancel_order`");
    expect(fm(smoke)["allowed-tools"]).not.toContain("mcp__acme-ops-agent__cancel_order");
  });

  it("CLAUDE.md is concise and covers rules, commands, API and safety", () => {
    const c = gen(sampleSpec())["CLAUDE.md"]!;
    expect(c).toContain("## Working rules");
    expect(c).toContain("### Role");
    expect(c).toContain("`npm test -- <pattern>`");
    expect(c).toContain("`$ACME_BASE_URL`");
    expect(c).toContain("Ask for explicit confirmation before: `cancel_order`, `write_file`");
    expect(c).toContain("`git push --force`");
    expect(c).not.toContain("ACME_API_TOKEN=");
    expect(c.length).toBeLessThan(4000);
  });

  it("CLAUDE.md abridges very long system prompts", () => {
    const long = "# Rules\n\n" + Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ${"x".repeat(60)}`).join("\n\n");
    const c = gen(sampleSpec({ systemPrompt: long }))["CLAUDE.md"]!;
    expect(c).toContain("_Abridged. Full prompt: `.claude/agents/acme-ops-agent.md`._");
    expect(c.length).toBeLessThan(7000);
  });

  it("nasty strings: frontmatter stays valid and injections are neutralized", () => {
    const spec = nasty();
    const files = gen(spec);
    const sub = files[".claude/agents/test-triager.md"]!;
    const d = fm(sub);
    expect(d.name).toBe("test-triager");
    expect(d.description).toBe("Delegate: when # failing | tests --- not frontmatter ---");
    expect(parseFrontmatter(sub).body).toContain("name: evil");
    const main = fm(files[".claude/agents/acme-ops-agent.md"]!);
    expect(main.description).toContain("Ops: triage # fast | safe `code` 'quoted' \"dq\" - not a list");
    for (const [p, c] of Object.entries(files)) {
      if (!p.startsWith(".claude/skills/") && !p.startsWith(".claude/commands/")) continue;
      expect(c, p).not.toContain("!`");
      expect(c, p).not.toMatch(/^\s*```\s*!/m);
    }
    const skill = files[".claude/skills/run-checks/SKILL.md"]!;
    expect(skill).toContain("\\$ARGUMENTS");
    const api = files[".claude/skills/call-acme-api/SKILL.md"]!;
    expect(api).toContain("| `list_orders` | `GET /orders` | read-only |");
    expect(api).toContain("List | orders");
    for (const c of [files[".claude/settings.json"]!, files[".mcp.json"]!]) expect(() => JSON.parse(c)).not.toThrow();
  });

  it("README explains install and lists every generated file", () => {
    const files = generateClaudeCode(sampleSpec(), OPTS);
    const readme = files.find((f) => f.path === "README.md")!.content;
    expect(readme).toContain("--in-place");
    expect(readme).toContain("cp -R agent/claude-code/CLAUDE.md agent/claude-code/.claude agent/claude-code/.mcp.json .");
    for (const f of files) expect(readme).toContain(`\`${f.path}\``);
  });

  it("is deterministic", () => {
    const a: GeneratedFile[] = generateClaudeCode(sampleSpec(), OPTS);
    const b: GeneratedFile[] = generateClaudeCode(sampleSpec(), OPTS);
    expect(a).toEqual(b);
    expect(generateClaudeCode(nasty(), OPTS)).toEqual(generateClaudeCode(nasty(), OPTS));
  });
});

describe("generateClaudeCode: decisions", () => {
  const decisions = [
    { id: "adr-0001-db", title: "Database", constraint: "Only src/db writes SQL.", status: "live" as const, governs: ["src/db/**"], source: "docs/adr/0001-db.md" },
    { id: "rule-claude-md-no-floats", title: "No floats", constraint: "Never use floats for money.", status: "proposed" as const, governs: ["**"], source: "CLAUDE.md:4" },
  ];

  it("without the MCP target: the decisions skill script, allowed by one narrow Bash rule, and nothing listed inline", () => {
    const files = gen(withDecisions(noHttp(), decisions), { ...OPTS, targets: ["typescript", "claude-code"] } as typeof OPTS);
    const claudeMd = files["CLAUDE.md"]!;
    expect(claudeMd).toContain("## Team decisions");
    expect(claudeMd).toContain("run `node .claude/skills/decisions/get-decisions.mjs <paths...>`");
    expect(claudeMd).not.toContain("Only src/db writes SQL");
    expect(claudeMd).not.toContain("adr-0001-db");
    expect(files[".mcp.json"]).toBeUndefined();
    expect(files[".claude/skills/decisions/get-decisions.mjs"]).toMatch(/^#!\/usr\/bin\/env node/);
    expect(JSON.parse(files[".claude/skills/decisions/decisions.json"]!)).toEqual(decisions);
    const skill = fm(files[".claude/skills/decisions/SKILL.md"]!);
    expect(skill["allowed-tools"]).toEqual(["Bash(node .claude/skills/decisions/get-decisions.mjs:*)"]);
    const settings = JSON.parse(files[".claude/settings.json"]!);
    expect(settings.permissions.allow).toContain("Bash(node .claude/skills/decisions/get-decisions.mjs:*)");
    expect(settings.permissions.allow).not.toContain("Bash");
    const agent = files[".claude/agents/acme-ops-agent.md"]!;
    expect(fm(agent).skills).toContain("decisions");
    expect(agent).toMatch(/- `get_decisions`: run `node \.claude\/skills\/decisions\/get-decisions\.mjs <paths\.\.\.>` with Bash/);
  });

  it("with the MCP target: the MCP tool, wired in .mcp.json, with the script as fallback", () => {
    const files = gen(withDecisions(noHttp(), decisions), { ...OPTS, targets: ["mcp", "claude-code"] } as typeof OPTS);
    expect(files["CLAUDE.md"]).toContain("call `mcp__acme-ops-agent__get_decisions` with the files or directories you will change");
    expect(files["CLAUDE.md"]).toContain("If the MCP server is not running, run `node .claude/skills/decisions/get-decisions.mjs <paths...>` instead.");
    expect(JSON.parse(files[".mcp.json"]!).mcpServers["acme-ops-agent"]).toBeDefined();
    const settings = JSON.parse(files[".claude/settings.json"]!);
    expect(settings.enabledMcpjsonServers).toEqual(["acme-ops-agent"]);
    expect(settings.permissions.allow).toContain("mcp__acme-ops-agent__get_decisions");
    expect(fm(files[".claude/agents/acme-ops-agent.md"]!).tools).toContain("mcp__acme-ops-agent__get_decisions");
    expect(files["README.md"]).toContain("`get_decisions` is served by the generated MCP server");
  });

  it("with API tools and no target list, the MCP server is already wired, so it serves get_decisions too", () => {
    const files = gen(withDecisions(sampleSpec(), decisions));
    expect(files["CLAUDE.md"]).toContain("`mcp__acme-ops-agent__get_decisions`");
    expect(files["README.md"]).toContain("The API tools and `get_decisions` are served by the generated MCP server");
  });
});
