import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function agentPy(ctx: PyContext): string {
  const D = "$";
  const S = ctx.has.subagents;
  const subImport = S ? "\nfrom .subagents import SUBAGENTS, SubagentDef, delegate_tool_param" : "";
  const subInitArg = S ? "\n        enable_subagents: bool = True," : "";
  const subInitBody = S
    ? `
        self.subagents: tuple[SubagentDef, ...] = SUBAGENTS if enable_subagents else ()
        self._delegates = {sub.tool_name: sub for sub in self.subagents}
        self._tool_params += [delegate_tool_param(sub) for sub in self.subagents]`
    : "";
  const subPlan = S
    ? `
            delegate = self._delegates.get(block.name)
            if delegate is not None:
                jobs.append(_Job(block, args, run=lambda d=delegate, a=args: self._delegate(d, a, log)))
                continue`
    : "";
  const subMethod = S
    ? String.raw`

    # -- subagents -----------------------------------------------------------

    def _delegate(self, sub: SubagentDef, args: dict[str, Any], log: list[ToolCall]) -> ToolResult:
        """Run a nested agent loop for a subagent and return its final report."""
        task = args.get("task")
        if not isinstance(task, str) or not task.strip():
            return ToolResult.error("A non-empty 'task' string is required.")
        budget = None if self.max_cost_usd is None else max(0.0, self.max_cost_usd - self.cost_usd)
        child = Agent(
            client=self.client,
            model=sub.resolved_model,
            system_prompt=sub.system_prompt,
            tool_names=sub.tools,
            effort=sub.effort,
            max_turns=self.max_turns,
            max_cost_usd=budget,
            approve=self.approve,
            on_event=self.on_event,
            root=self.ctx.project_root,
            dry_run=self.ctx.dry_run,
            name=sub.name,
            enable_subagents=False,
        )
        try:
            result = child.run(task)
        finally:
            self.usage.add(child.usage)
            self.cost_usd += child.cost_usd
        log.extend(result.tool_calls)
        if result.stop_reason == "refusal":
            return ToolResult.error(result.notice or "The subagent declined the task.")
        text = result.final_text.strip() or f"(the subagent produced no report; stop reason: {result.stop_reason})"
        if result.notice:
            text += f"\n\n[{result.notice}]"
        return ToolResult(text)`
    : "";

  return String.raw`${docstring(ctx, "The agent loop: streaming requests, tool execution, approvals, guardrails and cost tracking.")}

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anthropic

from . import config
from .prompt import SYSTEM_PROMPT${subImport}
from .tools import (
    DECLINED_MESSAGE,
    TOOLS,
    TOOLS_BY_API_NAME,
    ToolContext,
    ToolDef,
    ToolResult,
    api_tool_params,
    execute_tool,
    needs_approval,
)

#: Upper bound on read-only tools run at the same time.
MAX_PARALLEL_TOOLS = 8

ApprovalCallback = Callable[[ToolDef, dict[str, Any]], bool]


@dataclass(frozen=True)
class AgentEvent:
    """Something that happened during a run, for display or logging.

    type is one of: text, thinking, tool_call, tool_result, approval_denied,
    turn_end, notice. agent is "main" or the subagent name.
    """

    type: str
    data: dict[str, Any]
    agent: str = "main"


EventCallback = Callable[[AgentEvent], None]


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    @classmethod
    def from_api(cls, usage: Any) -> "Usage":
        return cls(
            input_tokens=getattr(usage, "input_tokens", 0) or 0,
            output_tokens=getattr(usage, "output_tokens", 0) or 0,
            cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        )

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens

    def minus(self, other: "Usage") -> "Usage":
        return Usage(
            self.input_tokens - other.input_tokens,
            self.output_tokens - other.output_tokens,
            self.cache_read_tokens - other.cache_read_tokens,
            self.cache_write_tokens - other.cache_write_tokens,
        )

    def copy(self) -> "Usage":
        return Usage(self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens)


@dataclass
class ToolCall:
    name: str
    input: Any
    output: str
    is_error: bool
    ms: int = 0


@dataclass
class RunResult:
    final_text: str
    turns: int
    tool_calls: list[ToolCall]
    usage: Usage
    cost_usd: float
    #: The API stop_reason of the last response, or "max_turns" / "max_cost".
    stop_reason: str | None
    #: Why the run ended early (refusal details, truncation, a guardrail), if it did.
    notice: str | None = None


@dataclass
class _Job:
    block: Any
    args: dict[str, Any]
    run: Callable[[], ToolResult] | None = None
    parallel: bool = False
    result: ToolResult | None = None
    ms: int = 0


def _block_type(block: Any) -> str | None:
    return block.get("type") if isinstance(block, dict) else getattr(block, "type", None)


def _is_tool_block(block: Any) -> bool:
    kind = _block_type(block) or ""
    return kind in ("tool_use", "server_tool_use") or kind.endswith("_tool_result")


def _text_of(content: Sequence[Any]) -> str:
    return "".join(getattr(block, "text", "") or "" for block in content if _block_type(block) == "text")


class Agent:
    """A conversation with Claude plus the harness's tools.

    Keeps history across run() calls, so one Agent is one chat session.
    """

    def __init__(
        self,
        *,
        client: anthropic.Anthropic | None = None,
        model: str | None = None,
        system_prompt: str = SYSTEM_PROMPT,
        tool_names: Sequence[str] | None = None,
        effort: str | None = None,
        max_turns: int | None = None,
        max_cost_usd: float | None = config.MAX_COST_USD,
        approve: ApprovalCallback | None = None,
        on_event: EventCallback | None = None,
        root: Path | None = None,
        dry_run: bool = False,
        name: str = "main",${subInitArg}
    ) -> None:
        self.client = client or anthropic.Anthropic()
        self.model = model or config.MODEL
        self.system_prompt = system_prompt
        self.effort = effort or config.EFFORT
        self.max_turns = max_turns or config.MAX_TURNS
        self.max_cost_usd = max_cost_usd
        #: Called before any tool that needs_approval(); no callback means "deny".
        self.approve = approve
        self.on_event = on_event
        self.name = name
        self.ctx = ToolContext(project_root=root or config.project_root(), dry_run=dry_run)
        wanted = None if tool_names is None else set(tool_names)
        self.tools: list[ToolDef] = [tool for tool in TOOLS if wanted is None or tool.name in wanted]
        self._client_tools = {tool.api_name: tool for tool in self.tools if not tool.is_server_tool}
        self._tool_params: list[dict[str, Any]] = api_tool_params(tool.name for tool in self.tools)${subInitBody}
        self.messages: list[dict[str, Any]] = []
        self.usage = Usage()
        self.cost_usd = 0.0

    # -- public API ----------------------------------------------------------

    def reset(self) -> None:
        """Forget the conversation (spend so far is kept)."""
        self.messages = []

    def run(self, prompt: str) -> RunResult:
        """Send a user message and loop until the model is done or a guardrail trips."""
        start_usage, start_cost = self.usage.copy(), self.cost_usd
        tool_calls: list[ToolCall] = []
        turns = 0
        final_text = ""
        stop_reason: str | None = None
        notice: str | None = None
        self.messages.append({"role": "user", "content": prompt})
        try:
            while True:
                if turns >= self.max_turns:
                    stop_reason, notice = "max_turns", f"Stopped after {turns} turns (max_turns)."
                    break
                if self.max_cost_usd is not None and self.cost_usd >= self.max_cost_usd:
                    stop_reason = "max_cost"
                    notice = f"Stopped: estimated spend ${D}{self.cost_usd:.4f} reached the ${D}{self.max_cost_usd:.2f} limit."
                    break

                message = self._request()
                turns += 1
                self._account(message)
                stop_reason = message.stop_reason
                content = list(message.content)
                if stop_reason not in ("tool_use", "pause_turn", "end_turn"):
                    # Tool calls of a truncated/refused/otherwise stopped turn will never be
                    # answered: drop them (and server tool results, which would be orphans)
                    # so the kept history stays valid for the next request.
                    content = [block for block in content if not _is_tool_block(block)]
                    if stop_reason in ("max_tokens", "refusal") and not any(
                        _block_type(block) in ("text", "compaction") for block in content
                    ):
                        content = []
                # Keep the full content otherwise: thinking, tool_use and compaction blocks.
                # An empty assistant message is rejected once it is no longer the last turn.
                if content:
                    self.messages.append({"role": "assistant", "content": content})
                text = _text_of(message.content)
                if text.strip():
                    final_text = text
                self._record_server_tools(message.content, tool_calls)
                self._emit("turn_end", turn=turns, stop_reason=stop_reason, cost_usd=self.cost_usd)

                if stop_reason == "tool_use":
                    calls = [block for block in message.content if _block_type(block) == "tool_use"]
                    if not calls:
                        break
                    # Every tool_result goes back in ONE user message.
                    self.messages.append({"role": "user", "content": self._run_tools(calls, tool_calls)})
                    continue
                if stop_reason == "pause_turn":
                    continue  # a server tool paused mid-turn; re-send and the API resumes
                if stop_reason == "max_tokens":
                    notice = "The response hit max_tokens and was cut off; truncated tool calls were not run."
                elif stop_reason == "refusal":
                    notice = self._refusal_notice(message)
                elif stop_reason not in ("end_turn", "stop_sequence") and any(
                    _block_type(block) == "tool_use" for block in message.content
                ):
                    notice = f"Stopped ({stop_reason}); tool calls in the last response were not run."
                break
        except BaseException:
            self._close_dangling_tool_uses("Not executed: the run was interrupted.")
            raise
        if notice:
            self._emit("notice", message=notice)
        return RunResult(
            final_text=final_text,
            turns=turns,
            tool_calls=tool_calls,
            usage=self.usage.minus(start_usage),
            cost_usd=self.cost_usd - start_cost,
            stop_reason=stop_reason,
            notice=notice,
        )

    def export_messages(self) -> list[dict[str, Any]]:
        """The conversation as plain JSON-serializable dicts (for transcripts)."""

        def plain(value: Any) -> Any:
            if hasattr(value, "model_dump"):
                return value.model_dump(mode="json", exclude_none=True)
            if isinstance(value, list):
                return [plain(item) for item in value]
            if isinstance(value, dict):
                return {key: plain(item) for key, item in value.items()}
            return value

        return [plain(message) for message in self.messages]

    # -- model requests ------------------------------------------------------

    def request_params(self) -> dict[str, Any]:
        """Keyword arguments for messages.stream (without beta-only fields)."""
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": config.MAX_OUTPUT_TOKENS,
            "messages": self.messages,
            "output_config": {"effort": self.effort},
        }
        if self.system_prompt:
            system_block: dict[str, Any] = {"type": "text", "text": self.system_prompt}
            if config.PROMPT_CACHING:
                system_block["cache_control"] = {"type": "ephemeral"}
            params["system"] = [system_block]
        if config.PROMPT_CACHING:
            # Automatic caching: the API moves this breakpoint to the end of the conversation.
            params["cache_control"] = {"type": "ephemeral"}
        if self._tool_params:
            params["tools"] = self._tool_params
        if config.ADAPTIVE_THINKING:
            params["thinking"] = {"type": "adaptive"}
        return params

    def context_management(self) -> tuple[list[str], list[dict[str, Any]]]:
        """(betas, context_management edits) for the enabled context strategies."""
        betas: list[str] = []
        edits: list[dict[str, Any]] = []
        if config.CONTEXT_EDITING:
            betas.append(config.CONTEXT_EDITING_BETA)
            edits.append({"type": "clear_tool_uses_20250919"})
        if config.COMPACTION:
            betas.append(config.COMPACTION_BETA)
            edits.append({"type": "compact_20260112"})
        return betas, edits

    def _request(self) -> Any:
        params = self.request_params()
        betas, edits = self.context_management()
        if betas:
            stream_manager = self.client.beta.messages.stream(
                **params, betas=betas, context_management={"edits": edits}
            )
        else:
            stream_manager = self.client.messages.stream(**params)
        with stream_manager as stream:
            for event in stream:
                if event.type == "text":
                    self._emit("text", text=event.text)
                elif event.type == "thinking":
                    self._emit("thinking", text=event.thinking)
            return stream.get_final_message()

    def _account(self, message: Any) -> None:
        usage = Usage.from_api(message.usage)
        self.usage.add(usage)
        self.cost_usd += config.estimate_cost_usd(
            self.model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
        )

    @staticmethod
    def _refusal_notice(message: Any) -> str:
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None)
        explanation = getattr(details, "explanation", None)
        parts = ["The model declined to continue"]
        if category:
            parts.append(f" (category: {category})")
        if explanation:
            parts.append(f": {explanation}")
        return "".join(parts) + "."

    # -- tools ---------------------------------------------------------------

    def _run_tools(self, calls: list[Any], log: list[ToolCall]) -> list[dict[str, Any]]:
        """Approve, execute and collect results for every tool_use block of one response."""
        jobs: list[_Job] = []
        for block in calls:
            args = block.input if isinstance(block.input, dict) else {}
            self._emit("tool_call", id=block.id, name=block.name, input=block.input)${subPlan}
            tool = self._client_tools.get(block.name)
            if tool is None:
                jobs.append(_Job(block, args, result=ToolResult.error(f"Unknown tool: {block.name}")))
            elif needs_approval(tool) and not self._approved(tool, args):
                self._emit("approval_denied", id=block.id, name=block.name)
                jobs.append(_Job(block, args, result=ToolResult.error(DECLINED_MESSAGE)))
            else:
                jobs.append(
                    _Job(
                        block,
                        args,
                        run=lambda t=tool, i=block.input: execute_tool(t, i, self.ctx),
                        parallel=tool.read_only,
                    )
                )

        self._execute(jobs)

        results: list[dict[str, Any]] = []
        for job in jobs:
            result = job.result or ToolResult.error("Tool did not run.")
            log.append(ToolCall(job.block.name, job.block.input, result.output, result.is_error, job.ms))
            self._emit(
                "tool_result",
                id=job.block.id,
                name=job.block.name,
                output=result.output,
                is_error=result.is_error,
                ms=job.ms,
            )
            entry: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": job.block.id,
                "content": result.output or "(no output)",
            }
            if result.is_error:
                entry["is_error"] = True
            results.append(entry)
        return results

    def _execute(self, jobs: list[_Job]) -> None:
        """Run jobs in order; consecutive read-only jobs run concurrently."""
        pending = [job for job in jobs if job.run is not None]
        index = 0
        while index < len(pending):
            batch = [pending[index]]
            if pending[index].parallel:
                while index + len(batch) < len(pending) and pending[index + len(batch)].parallel:
                    batch.append(pending[index + len(batch)])
            if len(batch) == 1:
                self._run_job(batch[0])
            else:
                with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL_TOOLS, len(batch))) as pool:
                    list(pool.map(self._run_job, batch))
            index += len(batch)

    @staticmethod
    def _run_job(job: _Job) -> None:
        assert job.run is not None
        started = time.monotonic()
        try:
            job.result = job.run()
        except Exception as exc:  # executors already catch; this guards subagents and custom tools
            job.result = ToolResult.error(f"{job.block.name} failed: {type(exc).__name__}: {exc}")
        job.ms = int((time.monotonic() - started) * 1000)

    def _approved(self, tool: ToolDef, args: dict[str, Any]) -> bool:
        if self.approve is None:
            return False
        try:
            return bool(self.approve(tool, args))
        except EOFError:
            return False

    def _record_server_tools(self, content: Sequence[Any], log: list[ToolCall]) -> None:
        """Log server-side tool calls (web search/fetch) so evals can see them."""
        for block in content:
            if _block_type(block) == "server_tool_use":
                tool = TOOLS_BY_API_NAME.get(getattr(block, "name", ""))
                name = tool.name if tool else getattr(block, "name", "server_tool")
                log.append(ToolCall(name, getattr(block, "input", None), "(executed by the API)", False))
                self._emit("tool_call", id=getattr(block, "id", ""), name=name, input=getattr(block, "input", None), server=True)

    def _close_dangling_tool_uses(self, reason: str) -> None:
        """Answer tool_use blocks left without results so the history stays valid for the next turn."""
        if not self.messages or self.messages[-1].get("role") != "assistant":
            return
        content = self.messages[-1].get("content")
        if not isinstance(content, list):
            return
        ids = [
            block.get("id") if isinstance(block, dict) else getattr(block, "id", None)
            for block in content
            if _block_type(block) == "tool_use"
        ]
        if ids:
            self.messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": tool_id, "content": reason, "is_error": True}
                        for tool_id in ids
                    ],
                }
            )${subMethod}

    # -- events --------------------------------------------------------------

    def _emit(self, event_type: str, **data: Any) -> None:
        if self.on_event is not None:
            self.on_event(AgentEvent(event_type, data, self.name))


def run_once(prompt: str, **kwargs: Any) -> RunResult:
    """Convenience wrapper: one prompt, fresh agent."""
    return Agent(**kwargs).run(prompt)


def format_usage(usage: Usage, cost_usd: float) -> str:
    return (
        f"{usage.input_tokens:,} in / {usage.output_tokens:,} out tokens"
        f" (cache: {usage.cache_read_tokens:,} read, {usage.cache_write_tokens:,} written)"
        f" ~ ${D}{cost_usd:.4f}"
    )


__all__ = [
    "Agent",
    "AgentEvent",
    "ApprovalCallback",
    "EventCallback",
    "RunResult",
    "ToolCall",
    "Usage",
    "format_usage",
    "run_once",
]

`;
}
