import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsInitPy(ctx: PyContext): string {
  return `${docstring(ctx, "Tools available to the agent.")}

from .base import ToolResult, redact
from .registry import (
    DECLINED_MESSAGE,
    TOOLS,
    TOOLS_BY_API_NAME,
    TOOLS_BY_NAME,
    ToolContext,
    ToolDef,
    api_tool_params,
    execute_tool,
    needs_approval,
)

__all__ = [
    "DECLINED_MESSAGE",
    "TOOLS",
    "TOOLS_BY_API_NAME",
    "TOOLS_BY_NAME",
    "ToolContext",
    "ToolDef",
    "ToolResult",
    "api_tool_params",
    "execute_tool",
    "needs_approval",
    "redact",
]
`;
}
