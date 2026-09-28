import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision, HarnessSpec } from "../src/core/types.js";
import { runCli } from "../src/commands/program.js";
import { decisionsTable } from "../src/commands/decisions.js";
import { stripAnsi, visibleWidth } from "../src/ui/theme.js";

const FIXTURE = path.resolve("test/fixtures/decisions-repo");

let stdout = "";
let stderr = "";
let root: string;

beforeEach(async () => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cli-dec-"));
  await fs.cp(FIXTURE, root, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => runCli(["node", "decree-harness", "--no-color", "-C", root, ...args]);
const readSpec = async (): Promise<HarnessSpec> => JSON.parse(await fs.readFile(path.join(root, "decree.json"), "utf8")) as HarnessSpec;
const json = <T>(): T => {
  const out = JSON.parse(stdout) as T;
  stdout = "";
  return out;
};

describe("decisions CLI", () => {
  it("init extracts decisions, and the harness serves them through get_decisions", async () => {
    expect(await cli("init", "--yes", "--offline", "--targets", "all")).toBe(0);
    const all = stripAnsi(stdout + stderr);
    expect(all).toMatch(/Found 14 decisions: 2 live, 11 proposed, 1 superseded\. Confirm with `[^`]*decisions confirm`\./);
    const spec = await readSpec();
    expect(spec.decisions).toHaveLength(14);
    expect(spec.tools.at(-1)).toMatchObject({ name: "get_decisions", kind: "decisions" });
    expect(spec.systemPrompt).toContain("call `get_decisions`");
    for (const f of ["agent/typescript/decisions.json", "agent/python/ledger_service_agent/decisions.json", "agent/mcp-server/decisions.json", "agent/claude-code/.claude/skills/decisions/get-decisions.mjs"]) {
      await expect(fs.access(path.join(root, f))).resolves.toBeUndefined();
    }
    // The generated CLAUDE.md says how to look decisions up, and lists none of them.
    const claudeMd = await fs.readFile(path.join(root, "agent/claude-code/CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("mcp__ledger-service-agent__get_decisions");
    expect(claudeMd).not.toContain("adr-0001-use-postgres");
  });

  it("list, for, confirm and supersede", async () => {
    expect(await cli("init", "--yes", "--offline", "--targets", "typescript,claude-code")).toBe(0);
    stdout = "";

    expect(await cli("decisions", "--json")).toBe(0);
    expect(json<Decision[]>()).toHaveLength(14);
    expect(await cli("decisions", "list", "--status", "live", "--json")).toBe(0);
    expect(json<Decision[]>().map((d) => d.id)).toEqual(["adr-0001-use-postgres", "adr-0003-store-events-in-postgres"]);
    expect(await cli("decisions", "list", "--status", "maybe")).toBe(1);
    expect(stderr).toContain('Unknown status "maybe"');

    expect(await cli("decisions")).toBe(0);
    expect(stdout).toContain("14 decisions: 2 live, 11 proposed, 1 superseded");
    expect(stdout).toContain("adr-0001-use-postgres");
    stdout = "";

    expect(await cli("decisions", "for", "src/db/accounts.ts")).toBe(0);
    expect(stdout).toContain("2 decisions govern these paths");
    expect(stdout).toContain("[adr-0001-use-postgres]");
    expect(stdout).not.toContain("rule-claude-md-never-write-raw-sql");
    stdout = "";

    // An unknown id fails the whole command and changes nothing.
    expect(await cli("decisions", "confirm", "rule-claude-md-never-write-raw-sql-outside-src", "rule-claude-md-nope")).toBe(1);
    expect(stderr).toContain('No decision with id "rule-claude-md-nope"');
    expect((await readSpec()).decisions!.find((d) => d.id === "rule-claude-md-never-write-raw-sql-outside-src")!.status).toBe("proposed");

    expect(await cli("decisions", "confirm", "rule-claude-md-never-write-raw-sql-outside-src")).toBe(0);
    expect(stdout).toContain("rule-claude-md-never-write-raw-sql-outside-src proposed");
    expect((await readSpec()).decisions!.find((d) => d.id === "rule-claude-md-never-write-raw-sql-outside-src")!.status).toBe("live");
    // It regenerated (the harness was generated before): the TypeScript target serves the new live decision.
    const tsData = JSON.parse(await fs.readFile(path.join(root, "agent/typescript/decisions.json"), "utf8")) as Decision[];
    expect(tsData.find((d) => d.id === "rule-claude-md-never-write-raw-sql-outside-src")!.status).toBe("live");
    stdout = "";

    expect(await cli("decisions", "for", "src/db", "--json")).toBe(0);
    expect(json<Decision[]>().map((d) => d.id)).toEqual(["adr-0001-use-postgres", "rule-claude-md-never-write-raw-sql-outside-src", "adr-0003-store-events-in-postgres"]);

    expect(await cli("decisions", "supersede", "adr-0001-use-postgres", "--by", "adr-0001-use-postgres")).toBe(1);
    expect(await cli("decisions", "supersede", "adr-0001-use-postgres", "--by", "adr-0003-store-events-in-postgres", "--no-generate")).toBe(0);
    expect(stdout).toContain("generate` to update the generated agent");
    let d = (await readSpec()).decisions!.find((x) => x.id === "adr-0001-use-postgres")!;
    expect(d).toMatchObject({ status: "superseded", supersededBy: "adr-0003-store-events-in-postgres" });

    expect(await cli("decisions", "reject", "rule-claude-md-use-pino-for-logging-instead-of")).toBe(0);
    d = (await readSpec()).decisions!.find((x) => x.id === "rule-claude-md-use-pino-for-logging-instead-of")!;
    expect(d.status).toBe("superseded");
    expect(d.supersededBy).toBeUndefined();

    // Confirming a superseded decision reinstates it and clears supersededBy.
    expect(await cli("decisions", "confirm", "adr-0001-use-postgres")).toBe(0);
    d = (await readSpec()).decisions!.find((x) => x.id === "adr-0001-use-postgres")!;
    expect(d.status).toBe("live");
    expect(d.supersededBy).toBeUndefined();
  });

  it("extract keeps statuses on re-run, adds new decisions and flags missing sources", async () => {
    expect(await cli("init", "--yes", "--offline", "--targets", "typescript")).toBe(0);
    expect(await cli("decisions", "confirm", "rule-billing-agents-md-every-charge-must-carry-an-idempotency", "--no-generate")).toBe(0);
    stdout = "";

    expect(await cli("decisions", "extract", "--json")).toBe(0);
    let r = json<{ added: string[]; missing: unknown[]; decisions: Decision[] }>();
    expect(r.added).toEqual([]);
    expect(r.missing).toEqual([]);

    // A new rule, a deleted ADR and a rule removed from CLAUDE.md.
    const claude = path.join(root, "CLAUDE.md");
    const text = (await fs.readFile(claude, "utf8")).replace("- Use `pino` for logging instead of `console.log`.\n", "- Never log full card numbers.\n");
    await fs.writeFile(claude, text);
    await fs.rm(path.join(root, "services/billing/AGENTS.md"));

    expect(await cli("decisions", "extract", "--dry-run", "--json")).toBe(0);
    r = json();
    expect(r.added).toEqual(["rule-claude-md-never-log-full-card-numbers"]);
    expect(r.missing).toEqual([
      { id: "rule-claude-md-use-pino-for-logging-instead-of", reason: "not-found" },
      { id: "rule-billing-agents-md-every-charge-must-carry-an-idempotency", reason: "file-gone" },
      { id: "rule-billing-agents-md-only-talk-to-the-ledger-through", reason: "file-gone" },
    ]);
    // The retry rule is also written in the post-mortem: it was found there, so it follows its new source.
    expect(r.decisions.find((x) => x.id === "rule-billing-agents-md-never-retry-a-charge-without-reusing")!.source).toMatch(/^docs\/postmortems\/2026-03-12-duplicate-charges\.md:\d+$/);
    expect((await readSpec()).decisions).toHaveLength(14); // dry run

    expect(await cli("decisions", "extract", "--no-generate")).toBe(0);
    expect(stdout).toContain("no longer found in its source");
    expect(stdout).toContain("source file is gone");
    expect(stdout).toContain("Updated decree.json");
    const spec = await readSpec();
    expect(spec.decisions).toHaveLength(15); // nothing dropped silently
    expect(spec.decisions!.find((x) => x.id === "rule-billing-agents-md-every-charge-must-carry-an-idempotency")!.status).toBe("live");
    // The same retry rule is not added twice under a post-mortem id.
    expect(spec.decisions!.filter((x) => /reusing its original idempotency key/.test(x.constraint))).toHaveLength(1);
  });

  it("extract needs decree.json unless it is a dry run", async () => {
    expect(await cli("decisions", "extract")).toBe(1);
    expect(stderr).toContain("No decree.json here yet");
    expect(await cli("decisions", "extract", "--dry-run")).toBe(0);
    expect(stdout).toContain("Dry run: decree.json was not changed.");
    await expect(fs.access(path.join(root, "decree.json"))).rejects.toThrow();
  });

  it("the table keeps ids whole and fits narrow terminals", () => {
    const list: Decision[] = [
      { id: "rule-billing-agents-md-every-charge-must-carry-an-idempotency", title: "t", constraint: "c", status: "proposed", governs: ["services/billing/**"], source: "services/billing/AGENTS.md:3" },
    ];
    for (const width of [60, 80, 100, 120]) {
      const table = stripAnsi(decisionsTable(list, { width }));
      for (const line of table.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 120) expect(table).toContain(list[0]!.id);
    }
  });
});
