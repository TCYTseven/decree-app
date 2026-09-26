import type { PyContext } from "../context.js";
import { pyLiteral } from "../py.js";
import { docstring } from "./config.js";

export function evalsPy(ctx: PyContext): string {
  const cases = ctx.spec.evals.map((c) => ({
    id: c.id,
    input: c.input,
    expect: c.expect,
    ...(c.tags && c.tags.length ? { tags: c.tags } : {}),
  }));
  return String.raw`${docstring(ctx, "Eval runner: checks tool usage, answer content and an LLM-judged rubric per case.")}

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .dotenv import load_dotenv

if TYPE_CHECKING:
    import anthropic

    from .agent import RunResult

#: Cases from decree.json. Pass --file to run cases from an evals.json instead.
EVAL_CASES: list[dict[str, Any]] = ${pyLiteral(cases)}

JUDGE_SYSTEM = (
    "You grade an AI agent's behavior against a rubric. You see the user's request, "
    "the tools the agent called, and its final answer. Pass the case only if the "
    "rubric is clearly satisfied. Score from 0 to 1."
)

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "passed": {"type": "boolean"},
        "score": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["passed", "score", "reasoning"],
    "additionalProperties": False,
}


@dataclass
class Check:
    name: str
    passed: bool
    detail: str | None = None


@dataclass
class CaseResult:
    id: str
    passed: bool = False
    score: float = 0.0
    checks: list[Check] = field(default_factory=list)
    run: RunResult | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "passed": self.passed,
            "score": self.score,
            "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in self.checks],
        }
        if self.run is not None:
            data["run"] = {
                "finalText": self.run.final_text,
                "turns": self.run.turns,
                "toolCalls": [
                    {"name": t.name, "input": t.input, "output": t.output, "isError": t.is_error}
                    for t in self.run.tool_calls
                ],
                "costUsd": self.run.cost_usd,
            }
        if self.error is not None:
            data["error"] = self.error
        return data


def judge(client: anthropic.Anthropic, model: str, case: dict[str, Any], run: RunResult) -> Check:
    """Grade a run against the case rubric with Claude (structured JSON output)."""
    calls = "\n".join(
        f"- {call.name} {json.dumps(call.input, ensure_ascii=False)[:500]}" + (" (error)" if call.is_error else "")
        for call in run.tool_calls
    )
    prompt = (
        f"<rubric>\n{case['expect']['rubric']}\n</rubric>\n\n"
        f"<user_request>\n{case['input']}\n</user_request>\n\n"
        f"<tool_calls>\n{calls or '(none)'}\n</tool_calls>\n\n"
        f"<final_answer>\n{run.final_text or '(empty)'}\n</final_answer>"
    )
    response = client.messages.create(
        model=model,
        max_tokens=8000,
        system=JUDGE_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
    )
    text = next((block.text for block in response.content if block.type == "text"), "")
    try:
        verdict = json.loads(text)
    except json.JSONDecodeError:
        return Check("rubric", False, f"judge returned unparseable output (stop_reason={response.stop_reason})")
    return Check("rubric", bool(verdict.get("passed")), f"{verdict.get('score')}: {verdict.get('reasoning')}")


def run_case(
    case: dict[str, Any],
    *,
    client: anthropic.Anthropic,
    judge_model: str,
    approve_all: bool,
    root: Path | None,
) -> CaseResult:
    """Run one case in a fresh agent and score it."""
    import anthropic

    from .agent import Agent

    result = CaseResult(id=str(case.get("id")))
    expect: dict[str, Any] = case.get("expect") or {}
    try:
        agent = Agent(client=client, approve=(lambda tool, args: True) if approve_all else None, root=root)
        run = agent.run(str(case["input"]))
    except anthropic.AuthenticationError:
        raise
    except anthropic.APIError as exc:
        result.error = f"{type(exc).__name__}: {exc}"
        return result
    result.run = run

    called = {call.name for call in run.tool_calls}
    answer = run.final_text.lower()
    for name in expect.get("toolsCalled") or ():
        result.checks.append(Check(f"calls {name}", name in called, None if name in called else f"called: {sorted(called)}"))
    for name in expect.get("toolsNotCalled") or ():
        result.checks.append(Check(f"does not call {name}", name not in called))
    for needle in expect.get("contains") or ():
        result.checks.append(Check(f"answer contains {needle!r}", needle.lower() in answer))
    for needle in expect.get("notContains") or ():
        result.checks.append(Check(f"answer does not contain {needle!r}", needle.lower() not in answer))
    if expect.get("rubric"):
        try:
            result.checks.append(judge(client, judge_model, case, run))
        except anthropic.APIError as exc:
            result.checks.append(Check("rubric", False, f"judge failed: {exc}"))

    if run.stop_reason in ("refusal", "max_tokens", "max_turns", "max_cost"):
        result.checks.append(Check("run completed", False, run.notice or run.stop_reason))
    passed = sum(1 for check in result.checks if check.passed)
    result.score = passed / len(result.checks) if result.checks else 1.0
    result.passed = passed == len(result.checks)
    return result


def load_cases(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return EVAL_CASES
    data = json.loads(path.read_text(encoding="utf-8"))
    return list(data.get("cases", data) if isinstance(data, dict) else data)


def main(argv: list[str] | None = None) -> int:
    load_dotenv(Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env")
    parser = argparse.ArgumentParser(prog=f"python -m {__package__}.evals", description="Run the harness evals.")
    parser.add_argument("--case", action="append", default=[], help="run only this case id (repeatable)")
    parser.add_argument("--file", type=Path, help="load cases from an evals.json file")
    parser.add_argument("--judge-model", help="model for rubric grading (default: the agent model)")
    parser.add_argument("--root", type=Path, help="project root the tools operate on")
    parser.add_argument("--yes", action="store_true", help="approve tool calls that need approval (default: decline)")
    parser.add_argument("--json", action="store_true", help="print results as JSON")
    args = parser.parse_args(argv)

    import anthropic

    from . import config
    from .cli import describe_api_error

    cases = [case for case in load_cases(args.file) if not args.case or case.get("id") in args.case]
    if not cases:
        print("No eval cases to run.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    results: list[CaseResult] = []
    try:
        for case in cases:
            if not args.json:
                print(f"... {case.get('id')}", file=sys.stderr, flush=True)
            results.append(
                run_case(
                    case,
                    client=client,
                    judge_model=args.judge_model or config.MODEL,
                    approve_all=args.yes,
                    root=args.root.resolve() if args.root else None,
                )
            )
    except (anthropic.APIError, TypeError) as exc:
        message = describe_api_error(exc)
        if message is None:
            raise
        print(f"error: {message}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130

    if args.json:
        print(json.dumps([r.to_json() for r in results], indent=2, ensure_ascii=False))
    else:
        for r in results:
            status = "PASS" if r.passed else "FAIL"
            cost = f" ${"$"}{r.run.cost_usd:.4f}" if r.run else ""
            print(f"{status} {r.id} (score {r.score:.2f}){cost}")
            if r.error:
                print(f"    error: {r.error}")
            for check in r.checks:
                if not check.passed:
                    print(f"    x {check.name}" + (f": {check.detail}" if check.detail else ""))
        total_cost = sum(r.run.cost_usd for r in results if r.run)
        passed = sum(r.passed for r in results)
        print(f"\n{passed}/{len(results)} passed, agent spend ~ ${"$"}{total_cost:.4f}")
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
`;
}
