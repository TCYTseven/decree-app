import type { PyContext, PySubagent } from "../context.js";
import { pyStr, pyStrTuple, pyText } from "../py.js";
import { docstring } from "./config.js";

function subagentDef(s: PySubagent): string {
  return `    SubagentDef(
        name=${pyStr(s.name)},
        tool_name=${pyStr(s.toolName)},
        description=${pyText(s.description, "            ")},
        tools=${pyStrTuple(s.resolvedTools, "        ")},
        model=${s.model ? pyStr(s.model) : "None"},
        effort=${pyStr(s.effort ?? "medium")},
    ),`;
}

export function subagentsPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "Subagents: each one is exposed to the main agent as a delegate_to_<name> tool.")}

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import config
from .prompt import SUBAGENT_PROMPTS

TASK_DESCRIPTION = (
    "The complete task for the subagent, including every detail it needs. "
    "It cannot see this conversation and replies with a single final report."
)


@dataclass(frozen=True)
class SubagentDef:
    """A focused agent with its own prompt, tool subset, model and effort."""

    name: str
    tool_name: str
    description: str
    tools: tuple[str, ...]
    model: str | None
    effort: str

    @property
    def system_prompt(self) -> str:
        return SUBAGENT_PROMPTS[self.name]

    @property
    def resolved_model(self) -> str:
        return self.model or config.SUBAGENT_MODEL


SUBAGENTS: tuple[SubagentDef, ...] = (
${ctx.subagents.map(subagentDef).join("\n")}
)

SUBAGENTS_BY_TOOL: dict[str, SubagentDef] = {sub.tool_name: sub for sub in SUBAGENTS}


def delegate_tool_param(sub: SubagentDef) -> dict[str, Any]:
    """The client tool the main agent calls to hand work to this subagent."""
    return {
        "name": sub.tool_name,
        "description": sub.description,
        "input_schema": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": TASK_DESCRIPTION}},
            "required": ["task"],
        },
    }
`;
}
