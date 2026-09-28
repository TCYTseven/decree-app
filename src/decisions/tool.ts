import type { Decision, HarnessSpec, JSONSchema, ToolSpec } from "../core/types.js";

export const DECISIONS_TOOL_NAME = "get_decisions";

export const DECISIONS_TOOL_DESCRIPTION =
  "Returns the live team decisions (ADRs, post-mortem lessons, repo rules) that govern the files or directories you pass, most specific first. Call it before you edit or create code, with every path you plan to change. Follow the decisions it returns and cite the decision id when one constrains your change. If the request conflicts with a live decision, stop and tell the user which decision it conflicts with instead of working around it.";

export const DECISIONS_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Files or directories you will read or change, relative to the repo root, e.g. ['src/db/users.ts', 'migrations/']",
    },
    include_proposed: {
      type: "boolean",
      description: "Also return proposed decisions that a human has not confirmed yet (default false)",
    },
  },
  required: ["paths"],
};

/** The line added to the system prompt when the harness serves decisions. */
export const DECISIONS_PROMPT_LINE =
  "- Before you change code, call `get_decisions` with the files or directories you will touch. Follow the live decisions it returns and cite the decision id when one constrains your change. If a request conflicts with a live decision, stop and tell the user which decision it conflicts with.";

export function decisionsTool(): ToolSpec {
  return {
    name: DECISIONS_TOOL_NAME,
    description: DECISIONS_TOOL_DESCRIPTION,
    kind: "decisions",
    inputSchema: structuredClone(DECISIONS_INPUT_SCHEMA),
    readOnly: true,
    destructive: false,
    requiresApproval: false,
    source: "builtin",
  };
}

/** True when the spec has a tool that serves decisions. */
export function hasDecisionsTool(spec: Pick<HarnessSpec, "tools">): boolean {
  return spec.tools.some((t) => t.kind === "decisions");
}

/** Insert the get_decisions instruction as the first bullet under "How to work", or append a short section. */
export function withDecisionsPromptLine(prompt: string): string {
  if (prompt.includes(DECISIONS_TOOL_NAME)) return prompt;
  const lines = prompt.replace(/\s+$/, "").split("\n");
  const heading = lines.findIndex((l) => /^#{1,4}\s+how to work\b/i.test(l.trim()));
  if (heading >= 0) {
    let at = heading + 1;
    while (at < lines.length && lines[at]!.trim() === "") at++;
    lines.splice(at, 0, DECISIONS_PROMPT_LINE);
    return `${lines.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n\n# Team decisions\n${DECISIONS_PROMPT_LINE}\n`;
}

/** The prompt without the line withDecisionsPromptLine adds (and without its own section, when it added one). */
export function withoutDecisionsPromptLine(prompt: string): string {
  return prompt
    .replace(`\n\n# Team decisions\n${DECISIONS_PROMPT_LINE}\n`, "\n")
    .split("\n")
    .filter((l) => l !== DECISIONS_PROMPT_LINE)
    .join("\n");
}

/**
 * Attach `decisions` to a spec (when non-empty) and, once it holds at least one decision, make sure it serves them:
 * add the `get_decisions` tool (after the existing tools, so the cached tool prefix stays put) and the prompt line.
 * Idempotent; a spec without decisions comes back unchanged.
 */
export function withDecisions(spec: HarnessSpec, decisions?: Decision[]): HarnessSpec {
  const list = decisions?.length ? decisions : spec.decisions;
  const out: HarnessSpec = decisions?.length ? { ...spec, decisions: [...decisions] } : spec;
  if (!list?.length) return out;
  const next = { ...out };
  if (!hasDecisionsTool(next)) {
    const taken = new Set(next.tools.map((t) => t.name));
    let name = DECISIONS_TOOL_NAME;
    for (let i = 2; taken.has(name); i++) name = `${DECISIONS_TOOL_NAME}_${i}`;
    next.tools = [...next.tools, { ...decisionsTool(), name }];
  }
  next.systemPrompt = withDecisionsPromptLine(next.systemPrompt);
  return next;
}
