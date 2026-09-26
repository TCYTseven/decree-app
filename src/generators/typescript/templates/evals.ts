import type { TsModel } from "../model.js";
import { tsLiteral } from "../render.js";

export function evalsTs(m: TsModel): string {
  return `/**
 * Evals: run each case through the agent and check what it did.
 *
 *   npm run eval                 every case
 *   npm run eval -- <id> ...     selected cases
 *
 * Cases come from ../evals.json when present (the file decree-harness writes
 * next to this package), otherwise from the copy embedded below. Destructive
 * tools are always declined during evals.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runAgent, type RunAgentResult } from "./agent.js";
import { anthropic, describeError } from "./client.js";
import { MODEL, PACKAGE_DIR } from "./config.js";

interface EvalCase {
  id: string;
  /** The user message. */
  input: string;
  expect: {
    /** Tools that must be called at least once. */
    toolsCalled?: string[];
    toolsNotCalled?: string[];
    /** Case-insensitive substrings the final answer must contain. */
    contains?: string[];
    notContains?: string[];
    /** Graded by a Claude judge. */
    rubric?: string;
  };
  tags?: string[];
}

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

const EVALS_FILE = path.resolve(PACKAGE_DIR, "..", "evals.json");

const EMBEDDED_CASES: EvalCase[] = ${tsLiteral(m.spec.evals)};

/** Structured output schema for the rubric judge. */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "What the agent did, compared with the rubric." },
    passed: { type: "boolean" },
  },
  required: ["reasoning", "passed"],
  additionalProperties: false,
};

function loadCases(): EvalCase[] {
  if (!existsSync(EVALS_FILE)) return EMBEDDED_CASES;
  const data: unknown = JSON.parse(readFileSync(EVALS_FILE, "utf8"));
  const cases = Array.isArray(data) ? data : (data as { evals?: unknown } | null)?.evals;
  if (!Array.isArray(cases)) throw new Error(\`\${EVALS_FILE} should hold an array of eval cases or {"evals": [...]}.\`);
  return cases as EvalCase[];
}

async function runCase(c: EvalCase): Promise<{ checks: Check[]; result: RunAgentResult }> {
  const result = await runAgent({ prompt: c.input, approve: async ({ tool }) => !tool.destructive });
  const called = new Set(result.toolCalls.map((t) => t.name));
  const answer = result.finalText.toLowerCase();
  const checks: Check[] = [];
  for (const name of c.expect.toolsCalled ?? []) checks.push({ name: \`calls \${name}\`, passed: called.has(name) });
  for (const name of c.expect.toolsNotCalled ?? []) checks.push({ name: \`does not call \${name}\`, passed: !called.has(name) });
  for (const text of c.expect.contains ?? []) {
    checks.push({ name: \`contains "\${text}"\`, passed: answer.includes(text.toLowerCase()) });
  }
  for (const text of c.expect.notContains ?? []) {
    checks.push({ name: \`does not contain "\${text}"\`, passed: !answer.includes(text.toLowerCase()) });
  }
  if (c.expect.rubric) checks.push(await judge(c, c.expect.rubric, result));
  return { checks, result };
}

async function judge(c: EvalCase, rubric: string, result: RunAgentResult): Promise<Check> {
  const calls = result.toolCalls
    .map((t) => \`- \${t.name}(\${clip(JSON.stringify(t.input), 300)}) -> \${t.isError ? "ERROR " : ""}\${clip(t.output, 500)}\`)
    .join("\\n");
  const prompt = [
    \`<rubric>\\n\${rubric}\\n</rubric>\`,
    \`<user_request>\\n\${c.input}\\n</user_request>\`,
    \`<tool_calls>\\n\${calls || "(none)"}\\n</tool_calls>\`,
    \`<final_answer>\\n\${result.finalText || "(empty)"}\\n</final_answer>\`,
    "Does the agent's behavior satisfy the rubric?",
  ].join("\\n\\n");

  const response = await anthropic().beta.messages.create({
    model: MODEL.id,
    max_tokens: 4000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    system: "You grade an AI agent against a rubric. Judge only what the transcript shows; be strict.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const verdict = JSON.parse(text) as { reasoning: string; passed: boolean };
  return { name: "rubric", passed: verdict.passed, detail: verdict.reasoning };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const cases = loadCases().filter((c) => only.length === 0 || only.includes(c.id));
  if (cases.length === 0) {
    console.log(only.length > 0 ? \`No eval cases match: \${only.join(", ")}\` : "No eval cases defined.");
    return;
  }

  const rows: string[][] = [];
  let failed = 0;
  for (const c of cases) {
    process.stderr.write(\`running \${c.id}…\\n\`);
    try {
      const { checks, result } = await runCase(c);
      const passedCount = checks.filter((ch) => ch.passed).length;
      const passed = passedCount === checks.length;
      if (!passed) failed++;
      const failures = checks.filter((ch) => !ch.passed).map((ch) => (ch.detail ? \`\${ch.name}: \${ch.detail}\` : ch.name));
      rows.push([
        c.id,
        passed ? "PASS" : "FAIL",
        checks.length > 0 ? (passedCount / checks.length).toFixed(2) : "1.00",
        String(result.turns),
        \`$\${result.costUsd.toFixed(4)}\`,
        clip(failures.join("; ").replace(/\\s+/g, " "), 160),
      ]);
    } catch (err) {
      failed++;
      rows.push([c.id, "ERROR", "0.00", "-", "-", describeError(err)]);
    }
  }

  printTable(["case", "result", "score", "turns", "cost", "failures"], rows);
  console.log(\`\\n\${cases.length - failed}/\${cases.length} passed\`);
  if (failed > 0) process.exitCode = 1;
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
`;
}
