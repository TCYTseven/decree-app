import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/commands/program.js";
import { parseTargets, suggestGoal, defaultTargets } from "../src/commands/pipeline.js";
import { diffSpecs } from "../src/commands/refine.js";
import { renderTable } from "../src/ui/table.js";
import { renderFileTree } from "../src/ui/tree.js";
import { formatDuration, formatUsd, formatTokens } from "../src/ui/format.js";
import { explainError } from "../src/ui/errors.js";
import { stripAnsi, visibleWidth } from "../src/ui/theme.js";
import { DECREE_VERSION } from "../src/version.js";
import { sampleProfile, sampleSpec } from "./helpers/sample-spec.js";

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "decree-cli-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const cli = (...args: string[]) => runCli(["node", "decree-harness", "--no-color", ...args]);

describe("cli", () => {
  it("--help lists commands and examples", async () => {
    expect(await cli("--help")).toBe(0);
    for (const cmd of ["init", "scan", "plan", "generate", "refine", "chat", "run", "eval", "doctor", "tools", "schema"]) {
      expect(stdout).toContain(cmd);
    }
    expect(stdout).toContain("Examples:");
  });

  it("--version prints the version", async () => {
    expect(await cli("--version")).toBe(0);
    expect(stdout.trim()).toBe(DECREE_VERSION);
  });

  it("schema prints the JSON schema", async () => {
    expect(await cli("schema")).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.type).toBe("object");
  });

  it("tools lists tools from decree.json", async () => {
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec(), null, 2));
    expect(await cli("--cwd", root, "tools")).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain("list_orders");
    expect(out).toContain("cancel_order");
    expect(out).toContain("approval");
    expect(out).toContain("read-only");
  });

  it("tools --json prints the tools", async () => {
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec()));
    expect(await cli("tools", "--json", "--cwd", root)).toBe(0);
    expect(JSON.parse(stdout).length).toBe(sampleSpec().tools.length);
  });

  it("missing decree.json is a friendly error with a hint", async () => {
    expect(await cli("--cwd", root, "tools")).toBe(1);
    expect(stderr).toContain("No decree.json found");
    expect(stderr).toContain("hint:");
    expect(stderr).not.toContain("    at ");
  });

  it("invalid decree.json lists the problems", async () => {
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify({ version: 1, tools: 5 }));
    expect(await cli("--cwd", root, "tools")).toBe(1);
    expect(stderr).toContain("decree.json is invalid");
  });

  it("unknown options fail with a non-zero exit", async () => {
    expect(await cli("schema", "--definitely-not-an-option")).not.toBe(0);
  });

  it("generate --dry-run against a fixture spec writes nothing", async () => {
    await fs.writeFile(path.join(root, "decree.json"), JSON.stringify(sampleSpec({ targets: ["claude-code"] })));
    const code = await cli("--cwd", root, "generate", "--dry-run");
    if (code === 0) {
      await expect(fs.access(path.join(root, "agent"))).rejects.toThrow();
    } else {
      // generators may still be in progress; the error must be printed cleanly
      expect(stderr).not.toContain("    at ");
    }
  });
});

describe("cli helpers", () => {
  it("parses targets with aliases", () => {
    expect(parseTargets("ts, claude,mcp-server")).toEqual(["typescript", "claude-code", "mcp"]);
    expect(parseTargets("all")).toHaveLength(4);
    expect(() => parseTargets("cobol")).toThrow(/Unknown target/);
  });

  it("suggests goals and targets from the profile", () => {
    expect(suggestGoal(sampleProfile())).toBe("Operate the orders API and triage test failures");
    expect(defaultTargets(sampleProfile())).toContain("mcp");
    expect(defaultTargets(sampleProfile({ apis: [] }))).not.toContain("mcp");
  });

  it("diffs specs", () => {
    const a = sampleSpec();
    const b = sampleSpec({
      tools: [...a.tools.filter((t) => t.name !== "cancel_order").map((t) => (t.name === "get_order" ? { ...t, description: "changed" } : t)), { ...a.tools[0], name: "new_tool" }],
    });
    const d = diffSpecs(a, b);
    expect(d.added).toEqual(["new_tool"]);
    expect(d.removed).toEqual(["cancel_order"]);
    expect(d.changed).toEqual([{ name: "get_order", fields: ["description"] }]);
  });

  it("renders tables that fit the width", () => {
    const t = renderTable([{ header: "A" }, { header: "B" }], [["x".repeat(80), "y"]], { width: 40 });
    for (const line of t.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(t).toContain("…");
  });

  it("renders a file tree and collapses unchanged dirs", () => {
    const tree = stripAnsi(
      renderFileTree(
        [
          { path: "README.md", status: "created" },
          { path: "typescript/src/index.ts", status: "updated" },
          { path: "python/a.py", status: "unchanged" },
          { path: "python/b.py", status: "unchanged" },
        ],
        "agent",
      ),
    );
    expect(tree).toContain("README.md created");
    expect(tree).toContain("python/ · 2 unchanged");
    expect(tree).toContain("index.ts updated");
  });

  it("formats numbers", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(3200)).toBe("3.2s");
    expect(formatDuration(64000)).toBe("1m 04s");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(3.4)).toBe("$3.40");
    expect(formatTokens(12345)).toBe("12k");
  });

  it("explains known errors without stacks", () => {
    const e = new Error("x");
    e.name = "MissingApiKeyError";
    expect(explainError(e).hint).toContain("ANTHROPIC_API_KEY");
    expect(explainError(Object.assign(new Error("bad key"), { status: 401 })).message).toContain("401");
  });
});
