import type { PyContext } from "../context.js";
import { pyStr } from "../py.js";
import { docstring } from "./config.js";

export function dotenvPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "Minimal .env loader (no extra dependency).")}

from __future__ import annotations

import os
import re
from pathlib import Path

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def parse_dotenv(text: str) -> dict[str, str]:
    """Parse KEY=VALUE lines. Supports comments, export, and single/double quotes."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _LINE.match(line)
        if not match:
            continue
        key, raw = match.groups()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            value = raw[1:-1]
            if raw[0] == '"':
                value = (
                    value.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\\\", "\\")
                )
        else:
            value = re.split(r"\s+#", raw, maxsplit=1)[0].strip()
        values[key] = value
    return values


def load_dotenv(*paths: Path) -> list[Path]:
    """Load each existing file into os.environ without overriding variables already set."""
    loaded: list[Path] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for key, value in parse_dotenv(text).items():
            os.environ.setdefault(key, value)
        loaded.append(path)
    return loaded
`;
}

export function cliPy(ctx: PyContext): string {
  const P = ctx.envPrefix;
  return String.raw`${docstring(ctx, "Command line interface: one-shot prompts or an interactive session.")}

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, TextIO

from . import __version__
from .dotenv import load_dotenv

if TYPE_CHECKING:
    from .agent import Agent, AgentEvent
    from .tools import ToolDef

PROG = ${pyStr(ctx.script)}
PACKAGE_DIR = Path(__file__).resolve().parent

HELP_TEXT = """Commands:
  /cost    show tokens and estimated spend for this session
  /reset   start a new conversation
  /help    show this help
  /exit    quit (also /quit or Ctrl-D)"""


class Console:
    """Terminal output: assistant text to stdout, activity to stderr."""

    def __init__(self, quiet: bool = False, show_thinking: bool = False) -> None:
        self.quiet = quiet
        self.show_thinking = show_thinking
        self.color = sys.stderr.isatty() and not os.environ.get("NO_COLOR")
        self._mid_line = False

    def style(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def _err(self, text: str) -> None:
        self._break_line()
        print(text, file=sys.stderr, flush=True)

    def _break_line(self, stream: TextIO = sys.stdout) -> None:
        if self._mid_line:
            print(file=stream, flush=True)
            self._mid_line = False

    def on_event(self, event: AgentEvent) -> None:
        data = event.data
        prefix = "" if event.agent == "main" else self.style(f"[{event.agent}] ", "35")
        if event.type == "text":
            if event.agent == "main":
                sys.stdout.write(data["text"])
                sys.stdout.flush()
                self._mid_line = not data["text"].endswith("\n")
        elif event.type == "thinking":
            if self.show_thinking and data["text"]:
                sys.stderr.write(self.style(data["text"], "2"))
                sys.stderr.flush()
        elif event.type == "tool_call" and not self.quiet:
            preview = json.dumps(data.get("input"), ensure_ascii=False)
            self._err(prefix + self.style(f"-> {data['name']}", "36") + " " + _clip(preview, 160))
        elif event.type == "tool_result" and not self.quiet:
            status = self.style("error", "31") if data["is_error"] else self.style("ok", "32")
            first = _clip(data["output"].strip().splitlines()[0] if data["output"].strip() else "", 120)
            self._err(prefix + f"<- {data['name']} {status} ({data['ms']} ms) {self.style(first, '2')}")
        elif event.type == "approval_denied":
            self._err(prefix + self.style(f"x {data['name']} declined", "33"))
        elif event.type == "notice":
            self._err(prefix + self.style(data["message"], "33"))

    def finish(self) -> None:
        self._break_line()


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def make_approver(auto_yes: bool, console: Console) -> Any:
    """y/N prompt on the terminal. Non-interactive runs deny unless --yes."""

    def approve(tool: ToolDef, args: dict[str, Any]) -> bool:
        from .tools import redact

        if auto_yes:
            return True
        if not sys.stdin.isatty():
            return False
        console.finish()
        preview = redact(json.dumps(args, indent=2, ensure_ascii=False))
        flags = ", ".join(
            flag
            for flag, on in (("destructive", tool.destructive), ("writes", not tool.read_only))
            if on
        )
        sys.stderr.write(console.style(f"\n{tool.name}", "1") + (f" ({flags})" if flags else "") + "\n")
        sys.stderr.write(_clip(preview, 2000) + "\n")
        try:
            answer = input("Allow this call? [y/N] ")
        except EOFError:
            return False
        return answer.strip().lower() in ("y", "yes")

    return approve


def build_parser() -> argparse.ArgumentParser:
    from . import config

    parser = argparse.ArgumentParser(
        prog=PROG,
        description=config.DISPLAY_NAME + ": " + config.DESCRIPTION,
        epilog="Run without a prompt for an interactive session. Evals: python -m "
        + __package__
        + ".evals",
    )
    parser.add_argument("prompt", nargs="*", help="prompt to run once ('-' reads it from stdin)")
    parser.add_argument("--root", type=Path, help="project root the tools operate on (default: cwd or ${P}_PROJECT_ROOT)")
    parser.add_argument("--model", help=f"model id (default: {config.MODEL})")
    parser.add_argument("-y", "--yes", action="store_true", help="approve every tool call without asking")
    parser.add_argument("--dry-run", action="store_true", help="describe tool calls instead of executing them")
    parser.add_argument("-q", "--quiet", action="store_true", help="hide tool activity")
    parser.add_argument("--thinking", action="store_true", help="show thinking output when the API returns it")
    parser.add_argument("--transcript", type=Path, help="write the conversation as JSON to this file on exit")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    # .env first: config reads the environment when it is imported.
    load_dotenv(Path.cwd() / ".env", PACKAGE_DIR.parent / ".env")
    args = build_parser().parse_args(argv)

    import anthropic

    from .agent import Agent, format_usage

    prompt = " ".join(args.prompt).strip()
    if prompt == "-" or (not prompt and not sys.stdin.isatty()):
        prompt = sys.stdin.read().strip()
    interactive = not prompt

    console = Console(quiet=args.quiet, show_thinking=args.thinking)
    try:
        agent = Agent(
            model=args.model,
            root=args.root.resolve() if args.root else None,
            dry_run=args.dry_run,
            approve=make_approver(args.yes, console),
            on_event=console.on_event,
        )
    except anthropic.AnthropicError as exc:
        print(f"error: could not create the Anthropic client: {exc}", file=sys.stderr)
        return 1

    try:
        if interactive:
            return repl(agent, console, format_usage)
        result = agent.run(prompt)
        console.finish()
        if not args.quiet:
            print(console.style(format_usage(result.usage, result.cost_usd), "2"), file=sys.stderr)
        return 0 if result.stop_reason in ("end_turn", "stop_sequence") else 2
    except KeyboardInterrupt:
        console.finish()
        print("interrupted", file=sys.stderr)
        return 130
    except (anthropic.APIError, TypeError) as exc:
        console.finish()
        message = describe_api_error(exc)
        if message is None:
            raise
        print(f"error: {message}", file=sys.stderr)
        return 1
    finally:
        if args.transcript:
            args.transcript.write_text(json.dumps(agent.export_messages(), indent=2, ensure_ascii=False), encoding="utf-8")


def describe_api_error(exc: BaseException) -> str | None:
    """A one-line explanation for common API failures (None = not an API problem)."""
    import anthropic

    if isinstance(exc, TypeError):
        # Raised by the SDK when no credentials are configured at all.
        if "authentication" in str(exc).lower():
            return "no Anthropic credentials found. Set ANTHROPIC_API_KEY (see .env.example)."
        return None
    if isinstance(exc, anthropic.AuthenticationError):
        return "authentication failed (401). Check ANTHROPIC_API_KEY."
    if isinstance(exc, anthropic.PermissionDeniedError):
        return "permission denied (403): this API key cannot use the requested model or feature."
    if isinstance(exc, anthropic.NotFoundError):
        return f"not found (404): check the model id. {getattr(exc, 'message', exc)}"
    if isinstance(exc, anthropic.RateLimitError):
        return "rate limited (429) after retries. Wait and try again."
    if isinstance(exc, anthropic.APIStatusError):
        return f"API error {exc.status_code}: {exc.message}"
    if isinstance(exc, anthropic.APIConnectionError):
        return f"could not reach the Anthropic API: {exc}"
    if isinstance(exc, anthropic.APIError):
        return str(exc)
    return None


def repl(agent: Agent, console: Console, format_usage: Any) -> int:
    import anthropic

    from . import config

    print(console.style(f"{config.DISPLAY_NAME} ({agent.model}). /help for commands, /exit to quit.", "2"))
    while True:
        try:
            line = input(console.style("you> ", "1"))
        except EOFError:
            print()
            return 0
        except KeyboardInterrupt:
            print()
            continue
        text = line.strip()
        if not text:
            continue
        if text in ("/exit", "/quit"):
            return 0
        if text == "/help":
            print(HELP_TEXT)
            continue
        if text == "/reset":
            agent.reset()
            print(console.style("Conversation cleared.", "2"))
            continue
        if text == "/cost":
            print(format_usage(agent.usage, agent.cost_usd))
            continue
        try:
            agent.run(text)
        except KeyboardInterrupt:
            console.finish()
            print(console.style("interrupted", "33"), file=sys.stderr)
            continue
        except (anthropic.APIError, TypeError) as exc:
            console.finish()
            message = describe_api_error(exc)
            if message is None:
                raise
            print(f"error: {message}", file=sys.stderr)
            if isinstance(exc, (anthropic.AuthenticationError, TypeError)):
                return 1
            continue
        console.finish()
        print()


if __name__ == "__main__":
    sys.exit(main())
`;
}
