import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  codeBlock,
  demoteHeadings,
  escapeTableCell,
  generateCommon,
  inlineCode,
  needsApproval,
  parseFrontmatter,
  renderTable,
  shellCommandPrefix,
  withFrontmatter,
} from "../src/generators/common/index.js";
import type { HarnessSpec } from "../src/core/types.js";
import { sampleSpec } from "./helpers/sample-spec.js";

const OPTS = { outDir: "agent", decreeVersion: "0.1.0" };

function byPath(spec: HarnessSpec) {
  return Object.fromEntries(generateCommon(spec, OPTS).map((f) => [f.path, f.content]));
}

/** Split a GFM table row into cells, honoring `\|` escapes. */
function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

function nastySpec(): HarnessSpec {
  const s = sampleSpec();
  s.displayName = "Nasty | Agent";
  s.description = "Does a | b and `c` things: # not a comment";
  s.tools[0]!.description = "List | orders\nwith `backticks` and ``double`` ticks";
  s.tools[0]!.source = "openapi:GET /a|b";
  s.subagents[0]!.description = "Delegate: when x | y\n# heading inside";
  s.evals[0]!.input = "How many | pending?\nSecond line";
  s.env.push({ name: "WEIRD_DEFAULT", description: "Has spaces\nand # hash", required: false, secret: false, default: 'a b # "c"' });
  s.systemPrompt = "# Role\nUse ```code``` and ````fences````\n```sh\nnpm test\n```";
  s.provenance.notes = ["note one", "multi\nline note"];
  return s;
}

describe("markdown helpers", () => {
  it("escapes pipes and newlines in table cells", () => {
    expect(escapeTableCell("a|b")).toBe("a\\|b");
    expect(escapeTableCell("a\nb")).toBe("a<br>b");
    expect(escapeTableCell("already \\| escaped")).toBe("already \\\\\\| escaped");
    expect(escapeTableCell(undefined)).toBe("");
    const t = renderTable(["A", "B"], [["x|y", "z"]]);
    const row = t.split("\n")[2]!;
    expect(cells(row)).toEqual(["x\\|y", "z"]);
  });

  it("inline code survives backticks", () => {
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("`x`")).toBe("`` `x` ``");
    expect(inlineCode("")).toBe("` `");
  });

  it("code blocks use a fence longer than any backtick run", () => {
    const b = codeBlock("x ```` y", "md");
    expect(b.startsWith("`````md\n")).toBe(true);
    expect(b.endsWith("\n`````")).toBe(true);
  });

  it("demotes headings outside fences only", () => {
    const md = "# A\n```\n# not heading\n```\n## B";
    expect(demoteHeadings(md, 2)).toBe("### A\n```\n# not heading\n```\n#### B");
    expect(demoteHeadings("###### deep", 3)).toBe("###### deep");
  });

  it("frontmatter round-trips YAML-special strings", () => {
    const data = { name: "x", description: "a: b # c | d\n- e 'f' \"g\"", list: ["y: z"] };
    const doc = withFrontmatter(data, "body");
    const parsed = parseFrontmatter(doc);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe("body\n");
  });

  it("frontmatter drops undefined keys", () => {
    expect(parseFrontmatter(withFrontmatter({ a: 1, b: undefined }, "")).data).toEqual({ a: 1 });
  });

  it("shell prefix and approval helpers", () => {
    expect(shellCommandPrefix("npm test -- {{pattern}}")).toBe("npm test");
    expect(shellCommandPrefix("make lint")).toBe("make lint");
    const t = sampleSpec().tools.find((x) => x.name === "cancel_order")!;
    expect(needsApproval(t, "never")).toBe(false);
    expect(needsApproval(t, "destructive")).toBe(true);
    const ro = sampleSpec().tools.find((x) => x.name === "read_file")!;
    expect(needsApproval(ro, "always")).toBe(false);
  });
});

describe("generateCommon", () => {
  it("emits the four root files", () => {
    const files = generateCommon(sampleSpec(), OPTS);
    expect(files.map((f) => f.path)).toEqual(["README.md", "evals.json", ".env.example", "harness.md", ".decree-generated"]);
    for (const f of files) expect(f.content.endsWith("\n")).toBe(true);
  });

  it("evals.json is the spec evals", () => {
    const spec = sampleSpec();
    expect(JSON.parse(byPath(spec)["evals.json"]!)).toEqual(spec.evals);
  });

  it(".env.example documents every var, fills defaults, leaves secrets empty", () => {
    const env = byPath(sampleSpec())[".env.example"]!;
    expect(env).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(env).toMatch(/^ACME_API_TOKEN=$/m);
    expect(env).toMatch(/^ACME_BASE_URL=http:\/\/localhost:3000$/m);
    expect(env).toContain("# Base URL of the Acme API");
    // every non-comment line is KEY=VALUE
    for (const line of env.split("\n")) if (line && !line.startsWith("#")) expect(line).toMatch(/^[A-Z_][A-Z0-9_]*=/);
  });

  it(".env.example quotes defaults with special characters and comments multi-line descriptions", () => {
    const env = byPath(nastySpec())[".env.example"]!;
    expect(env).toContain(`WEIRD_DEFAULT="a b # \\"c\\""`);
    expect(env).toContain("# Has spaces\n# and # hash");
  });

  it(".env.example adds tool-referenced vars missing from spec.env", () => {
    const env = byPath(sampleSpec({ env: [] }))[".env.example"]!;
    expect(env).toMatch(/^ACME_BASE_URL=http:\/\/localhost:3000$/m);
    expect(env).toMatch(/^ACME_API_TOKEN=$/m);
  });

  it("README has tools table, subagents, targets and source-of-truth note", () => {
    const md = byPath(sampleSpec())["README.md"]!;
    expect(md).toContain("# Acme Ops Agent");
    expect(md).toContain("| Name | Kind | Read-only | Approval | Source |");
    expect(md).toMatch(/\| `cancel_order` \| http \| no \| required \|/);
    expect(md).toContain("`test-triager`");
    expect(md).toContain("cd typescript && npm install && npm start");
    expect(md).toContain("cd python && uv");
    expect(md).toContain("mcp-server/");
    expect(md).toContain("claude-code/");
    expect(md).toContain("npx decree-harness generate");
    expect(md).toContain("decree.json");
  });

  it("README only lists selected targets and handles no subagents", () => {
    const md = byPath(sampleSpec({ targets: ["typescript"], subagents: [] }))["README.md"]!;
    expect(md).toContain("cd typescript");
    expect(md).not.toContain("cd python");
    expect(md).toMatch(/## Subagents\n\n_None._/);
  });

  it("harness.md contains full system prompt, every tool with schema, guardrails and notes", () => {
    const spec = sampleSpec();
    const md = byPath(spec)["harness.md"]!;
    expect(md).toContain(spec.systemPrompt);
    for (const t of spec.tools) expect(md).toContain(`### \`${t.name}\``);
    expect(md).toContain('"enum": [');
    expect(md).toContain("GET ${ACME_BASE_URL}/orders");
    expect(md).toContain("npm test -- <pattern>");
    expect(md).toContain("## Guardrails");
    expect(md).toContain("## Context strategy");
    expect(md).toContain("- sample spec for tests");
    expect(md).toContain("delegate_to_test_triager");
  });

  it("nasty strings keep every table row well-formed", () => {
    const files = byPath(nastySpec());
    for (const name of ["README.md", "harness.md"]) {
      const md = files[name]!;
      // Every table: all rows have the same number of cells as the header.
      const lines = md.split("\n");
      let inFence = false;
      let width = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (/^(`{3,}|~{3,})/.test(l)) inFence = !inFence;
        if (inFence || !l.startsWith("|")) {
          width = 0;
          continue;
        }
        const n = cells(l).length;
        if (width === 0) width = n;
        else expect(n, `${name}: ${l}`).toBe(width);
      }
    }
    const readme = files["README.md"]!;
    expect(readme).toContain("openapi:GET /a\\|b");
    expect(readme).toContain("How many \\| pending? Second line");
  });

  it("harness.md system prompt fence is not broken by backticks in the prompt", () => {
    const spec = nastySpec();
    const md = byPath(spec)["harness.md"]!;
    expect(md).toContain("`````markdown\n" + spec.systemPrompt + "\n`````");
  });

  it("is deterministic", () => {
    expect(generateCommon(sampleSpec(), OPTS)).toEqual(generateCommon(sampleSpec(), OPTS));
    expect(generateCommon(nastySpec(), OPTS)).toEqual(generateCommon(nastySpec(), OPTS));
  });

  it("handles an empty harness", () => {
    const files = byPath(sampleSpec({ tools: [], subagents: [], evals: [], env: [], targets: [] }));
    expect(JSON.parse(files["evals.json"]!)).toEqual([]);
    expect(files["README.md"]).toContain("_No tools._");
    expect(YAML).toBeDefined();
  });
});
