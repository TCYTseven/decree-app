import type { PyContext } from "../context.js";
import { pyStr, pyText } from "../py.js";
import { docstring } from "./config.js";

export function promptPy(ctx: PyContext): string {
  const sub = ctx.subagents.length
    ? `

#: System prompts for subagents, keyed by subagent name.
SUBAGENT_PROMPTS: dict[str, str] = {
${ctx.subagents.map((s) => `    ${pyStr(s.name)}: ${pyText(s.systemPrompt, "        ")},`).join("\n")}
}`
    : "";
  return `${docstring(ctx, "System prompt(s). Kept byte-stable so the prompt-cache prefix never changes between requests.")}

from __future__ import annotations

SYSTEM_PROMPT = ${pyText(ctx.spec.systemPrompt)}${sub}
`;
}
