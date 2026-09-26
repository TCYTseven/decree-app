/**
 * UX regression tests: snapshot the key non-TTY outputs at 80 columns (timings and temp paths
 * normalized) and check that tables, boxes and wrapped text never exceed a 60-column terminal.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/commands/program.js";
import { renderSteps, safetyLegend, toolsTable } from "../src/commands/pipeline.js";
import { selfCommand } from "../src/commands/context.js";
import { closest, groupWarnings } from "../src/ui/format.js";
import { formatCommanderError } from "../src/ui/errors.js";
import { renderTable } from "../src/ui/table.js";
import { stripAnsi, visibleWidth, wrapText } from "../src/ui/theme.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const FIXTURE = path.resolve(__dirname, "fixtures", "express-openapi");

let stdout = "";
let stderr = "";
let root: string;
const savedCols = process.env.COLUMNS;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => ((stdout += String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => ((stderr += String(chunk)), true));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "decree-ux-")));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.COLUMNS = "80";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedCols === undefined) delete process.env.COLUMNS;
  else process.env.COLUMNS = savedCols;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await fs.rm(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => runCli(["node", "decree-harness", "--no-color", "--cwd", root, ...args]);

/** Strip ANSI, timings and the temp dir so snapshots are stable. */
function normalize(s: string): string {
  return stripAnsi(s)
    .split(root)
    .join("<root>")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "<t>")
    .replace(/[ \t]+$/gm, "");
}

function widest(s: string): number {
  return Math.max(0, ...stripAnsi(s).split("\n").map(visibleWidth));
}

/** Run with the project as the working directory, like a user would. */
async function inRoot<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

const writeSpec = (spec: unknown) => fs.writeFile(path.join(root, "decree.json"), JSON.stringify(spec, null, 2));

describe("ux snapshots (80 columns, piped)", () => {
  it("tools", async () => {
    await writeSpec(sampleSpec());
    expect(await cli("tools")).toBe(0);
    expect(normalize(stdout)).toMatchSnapshot();
  });

  it("unknown command suggests the closest one", async () => {
    expect(await cli("genrate")).toBe(1);
    expect(normalize(stderr)).toMatchSnapshot();
  });

  it("unknown option is styled like our errors", async () => {
    expect(await cli("init", "--targts", "ts")).toBe(1);
    expect(normalize(stderr)).toMatchSnapshot();
  });

  it("missing decree.json", async () => {
    expect(await cli("tools")).toBe(1);
    expect(normalize(stderr)).toMatchSnapshot();
  });

  it("broken decree.json points at the line", async () => {
    await fs.writeFile(path.join(root, "decree.json"), '{\n  "version": 1,\n  "tools": [,\n  ]\n}\n');
    expect(await inRoot(() => cli("tools"))).toBe(1);
    expect(normalize(stderr)).toMatch(/decree\.json:3 is not valid JSON \(unexpected ","\)/);
  });

  it("schema errors list each problem", async () => {
    const spec = sampleSpec() as unknown as Record<string, any>;
    spec.model.effort = 7;
    await writeSpec(spec);
    expect(await cli("tools")).toBe(1);
    const err = normalize(stderr);
    expect(err).toContain("problem");
    expect(err).toContain("model.effort");
    expect(err).toContain("hint:");
  });

  it("an invalid --targets fails before scanning", async () => {
    await fs.cp(FIXTURE, root, { recursive: true });
    expect(await cli("init", "--yes", "--offline", "--targets", "rust")).toBe(1);
    expect(stdout).not.toContain("Scanned");
    expect(normalize(stderr)).toMatchSnapshot();
  });

  it("empty directory explains what happened and still produces an agent", async () => {
    expect(await inRoot(() => cli("init", "--yes", "--offline", "--targets", "typescript"))).toBe(0);
    const out = normalize(stdout + stderr).replace(/\n {3}/g, " ");
    expect(out).toContain("is empty");
    expect(out).toContain("general-purpose coding agent");
    expect(out).toMatch(/next: set ANTHROPIC_API_KEY, then .*decree-harness chat/);
    await expect(fs.stat(path.join(root, "decree.json"))).resolves.toBeTruthy();
  }, 30_000);

  it("init prints relative next steps and one best next command", async () => {
    await fs.cp(FIXTURE, root, { recursive: true });
    expect(await inRoot(() => cli("init", "--yes", "--offline", "--targets", "typescript,mcp"))).toBe(0);
    const out = normalize(stdout);
    const next = out.slice(out.indexOf("Next steps"));
    expect(next).toContain("cd agent/typescript && npm i && npm start");
    expect(next).not.toContain("<root>");
    expect(out.replace(/\n {3}/g, " ")).toMatch(/Ready in <t> · next: set ANTHROPIC_API_KEY, then .*decree-harness chat/);
    expect(widest(stdout)).toBeLessThanOrEqual(80);
  }, 30_000);

  it("generate --json prints the write report", async () => {
    await writeSpec(sampleSpec());
    expect(await cli("generate", "--json", "--targets", "claude-code")).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.created.length).toBeGreaterThan(0);
    expect(report.targets).toEqual(["claude-code"]);
  });

  it("rerunning generate with nothing changed prints no tree", async () => {
    await writeSpec(sampleSpec());
    await cli("generate", "--targets", "claude-code");
    stdout = "";
    expect(await cli("generate", "--targets", "claude-code")).toBe(0);
    const out = normalize(stdout);
    expect(out).toContain("is up to date");
    expect(out).not.toContain("├──");
  });
});

describe("ux fits a 60-column terminal", () => {
  beforeEach(() => {
    process.env.COLUMNS = "60";
  });

  it("tools table, legend and subagents", async () => {
    await writeSpec(sampleSpec());
    expect(await cli("tools")).toBe(0);
    expect(widest(stdout)).toBeLessThanOrEqual(60);
    expect(stripAnsi(stdout)).not.toMatch(/\w…\s*│/); // tool names are never truncated
  });

  it("init on a real fixture (boxes, tables, tree, next steps)", async () => {
    await fs.cp(FIXTURE, root, { recursive: true });
    expect(await cli("init", "--yes", "--offline", "--targets", "all")).toBe(0);
    for (const line of stripAnsi(stdout).split("\n")) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
  }, 30_000);

  it("doctor wraps hints under their check", async () => {
    await writeSpec(sampleSpec());
    await cli("doctor");
    for (const line of stripAnsi(stdout).split("\n")) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
  });

  it("errors wrap with a hanging indent", async () => {
    expect(await cli("tools")).toBe(1);
    for (const line of stripAnsi(stderr).split("\n")) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
  });

  it("help text wraps", async () => {
    await runCli(["node", "decree-harness", "--no-color", "--help"]);
    for (const line of stripAnsi(stdout).split("\n")) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
  });
});

describe("ux helpers", () => {
  it("renderTable never exceeds the width, even below column minimums", () => {
    const cols = [{ header: "Tool", min: 12 }, { header: "Kind", min: 8 }, { header: "Binds to", min: 10 }, { header: "Source", hideBelow: 100 }];
    const rows = [["a_really_long_tool_name", "http", "GET /orders/{id}/events", "openapi:GET /orders"]];
    for (const w of [120, 80, 60, 30]) {
      const t = renderTable(cols, rows, { width: w });
      expect(widest(t)).toBeLessThanOrEqual(w);
      expect(t.includes("Source")).toBe(w >= 100);
    }
  });

  it("toolsTable drops columns instead of truncating tool names, and has a legend", () => {
    const t = stripAnsi(toolsTable(sampleSpec(), { source: true, width: 60 }));
    for (const tool of sampleSpec().tools) expect(t).toContain(tool.name);
    expect(t).not.toContain("Source");
    expect(t).toContain("read-only");
    expect(stripAnsi(safetyLegend(sampleSpec().tools))).toMatch(/destructive, asks first/);
  });

  it("wrapText keeps words whole and styles intact", () => {
    const s = wrapText("\u001b[2mthe quick brown fox jumps over the lazy dog\u001b[22m", 16, "  ");
    const lines = stripAnsi(s).split("\n");
    expect(lines).toEqual(["the quick brown", "  fox jumps over", "  the lazy dog"]);
    expect(s.split("\n")[1]).toContain("\u001b[2m"); // style replayed on the continuation line
  });

  it("renderSteps stacks descriptions when two columns don't fit", () => {
    const steps: [string, string][] = [["npx decree-harness chat", "talk to your agent"]];
    expect(stripAnsi(renderSteps(steps, 80))).toBe("npx decree-harness chat  talk to your agent");
    expect(stripAnsi(renderSteps(steps, 30))).toBe("npx decree-harness chat\n  talk to your agent");
  });

  it("groups repeated warnings", () => {
    const w = groupWarnings(['evals[0].expect: unknown tool "x".', 'evals[3].expect: unknown tool "x".', "other"]);
    expect(w).toEqual(['evals[…].expect: unknown tool "x" (2 places)', "other"]);
  });

  it("suggests close command names", () => {
    expect(closest("genrate", ["generate", "gen", "doctor"])).toBe("generate");
    expect(closest("dcotor", ["generate", "doctor"])).toBe("doctor");
    expect(closest("banana", ["generate", "doctor"])).toBeUndefined();
  });

  it("formats commander errors on one line", () => {
    expect(stripAnsi(formatCommanderError("error: unknown option '--targts'\n(Did you mean --targets?)\n"))).toBe(
      "✗ Unknown option '--targts'. Did you mean --targets?\n",
    );
  });

  it("selfCommand reflects how decree was invoked", () => {
    expect(selfCommand(["node", "/usr/local/bin/decree"], {})).toBe("decree");
    expect(selfCommand(["node", "/usr/local/bin/decree-harness"], {})).toBe("decree-harness");
    expect(selfCommand(["node", "/x/dist/cli.js"], {})).toBe("npx decree-harness");
    expect(selfCommand(["node", "/usr/local/bin/decree"], { npm_command: "exec" })).toBe("npx decree-harness");
  });
});
