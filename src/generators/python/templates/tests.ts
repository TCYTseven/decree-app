import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function testToolsPy(ctx: PyContext): string {
  const { pkg, has } = ctx;
  const imports = [
    has.decisions ? `from ${pkg}.tools import decisions` : "",
    has.fs ? `from ${pkg}.tools import fs` : "",
    has.http ? `from ${pkg}.tools.http import build_request, encode_component` : "",
    has.memory ? `from ${pkg}.tools.memory import MemoryStore` : "",
    has.shell ? `from ${pkg}.tools import shell\nfrom ${pkg}.tools.shell import render_command, run_command, sh_quote` : "",
  ].filter(Boolean);

  const sections: string[] = [];

  sections.push(String.raw`
# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


def test_tool_names_are_valid_and_unique() -> None:
    names = [tool.name for tool in TOOLS]
    assert len(names) == len(set(names))
    for name in names:
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name), name


def test_api_params_follow_spec_order() -> None:
    params = api_tool_params()
    assert [param["name"] for param in params] == [tool.api_name for tool in TOOLS]
    for param in params:
        if "input_schema" in param:
            assert param["input_schema"].get("type") == "object"


def test_approval_policy() -> None:
    for tool in TOOLS:
        assert needs_approval(tool, "never") is False
        assert needs_approval(tool, "always") == (not tool.read_only or tool.requires_approval)
        assert needs_approval(tool, "destructive") == (tool.requires_approval or tool.destructive)


def test_validate_input() -> None:
    schema = {
        "type": "object",
        "properties": {"n": {"type": "integer"}, "mode": {"type": "string", "enum": ["a", "b"]}},
        "required": ["n"],
    }
    assert validate_input(schema, {"n": 1}) is None
    assert validate_input(schema, {}) is not None
    assert validate_input(schema, {"n": "1"}) is not None
    assert validate_input(schema, {"n": True}) is not None
    assert validate_input(schema, {"n": 1, "mode": "c"}) is not None


def test_non_object_input_is_rejected(tmp_path: Path) -> None:
    for tool in TOOLS:
        if not tool.is_server_tool:
            assert execute_tool(tool, "nope", ToolContext(project_root=tmp_path)).is_error


def test_dry_run_does_not_execute(tmp_path: Path) -> None:
    ctx = ToolContext(project_root=tmp_path, dry_run=True)
    for tool in TOOLS:
        if tool.is_server_tool or tool.kind == "memory":
            continue
        args = {key: "x" for key in tool.input_schema.get("required", [])}
        result = execute_tool(tool, args, ctx)
        assert result.output.startswith("[dry run]") or result.is_error


def test_redaction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(base, "REDACT_ENV", ("DECREE_TEST_SECRET",))
    monkeypatch.setenv("DECREE_TEST_SECRET", "s3cr3t-value")
    assert base.redact("token=s3cr3t-value;") == "token=[REDACTED:DECREE_TEST_SECRET];"


def test_truncation() -> None:
    assert base.truncate_head("abcdef", 3) == "abc\n…[truncated 3 chars]"
    assert base.truncate_tail("abcdef", 3) == "…[truncated 3 chars]\ndef"
    assert base.truncate_head("abc", 3) == "abc"`);

  if (has.fs) {
    sections.push(String.raw`
# --------------------------------------------------------------------------
# File tools
# --------------------------------------------------------------------------

ROOT = {"root": "."}


@pytest.fixture(autouse=True)
def _allow_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fs, "ALLOWED_PATHS", (".",))


def test_write_then_read(tmp_path: Path) -> None:
    written = fs.write_file(ROOT, {"path": "a/b.txt", "content": "héllo\n"}, tmp_path)
    assert not written.is_error
    assert written.output == "wrote 7 bytes to a/b.txt"
    assert fs.read_file(ROOT, {"path": "a/b.txt"}, tmp_path).output == "héllo\n"


def test_read_missing_file_is_error(tmp_path: Path) -> None:
    assert fs.read_file(ROOT, {"path": "nope.txt"}, tmp_path).is_error


def test_read_truncates(tmp_path: Path) -> None:
    (tmp_path / "big.txt").write_text("x" * 50)
    result = fs.read_file({"root": ".", "maxBytes": 10}, {"path": "big.txt"}, tmp_path)
    assert result.output.startswith("x" * 10 + "\n…[truncated")


def test_paths_cannot_escape_root(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("secret")
    for path in ("../secret.txt", str(tmp_path / "secret.txt"), "a/../../secret.txt"):
        assert fs.read_file(ROOT, {"path": path}, root).is_error, path
        assert fs.write_file(ROOT, {"path": path, "content": "x"}, root).is_error, path
    os.symlink(tmp_path, root / "link")
    assert fs.read_file(ROOT, {"path": "link/secret.txt"}, root).is_error


def test_allowed_paths_are_enforced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fs, "ALLOWED_PATHS", ("src",))
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "ok.txt").write_text("ok")
    (tmp_path / "other.txt").write_text("no")
    assert fs.read_file(ROOT, {"path": "src/ok.txt"}, tmp_path).output == "ok"
    assert fs.read_file(ROOT, {"path": "other.txt"}, tmp_path).is_error


def test_list_files_glob(tmp_path: Path) -> None:
    for rel in ("src/a.ts", "src/sub/b.ts", "src/c.js", "node_modules/x/d.ts", "README.md"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("x")
    assert fs.list_files(ROOT, {"pattern": "src/**/*.ts"}, tmp_path).output == "src/a.ts\nsrc/sub/b.ts"
    assert fs.list_files(ROOT, {"pattern": "**/*.ts"}, tmp_path).output == "src/a.ts\nsrc/sub/b.ts"
    assert fs.list_files(ROOT, {"pattern": "*.md"}, tmp_path).output == "README.md"
    assert fs.list_files(ROOT, {"pattern": "src/*.{ts,js}"}, tmp_path).output == "src/a.ts\nsrc/c.js"
    assert fs.list_files(ROOT, {"pattern": "../*"}, tmp_path).is_error


def test_search(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("one\nhello world\n")
    (tmp_path / "b.bin").write_bytes(b"hello\x00binary")
    result = fs.search(ROOT, {"query": "hel+o"}, tmp_path)
    assert result.output == "a.txt:2: hello world"
    assert fs.search(ROOT, {"query": "("}, tmp_path).is_error
    assert "No matches" in fs.search(ROOT, {"query": "hello", "glob": "*.md"}, tmp_path).output


def test_spec_file_tools_run(tmp_path: Path) -> None:
    ctx = ToolContext(project_root=tmp_path)
    for tool in TOOLS:
        root = fs.tool_root(tool.binding, tmp_path)
        root.mkdir(parents=True, exist_ok=True)
        if tool.kind == "read_file":
            (root / "probe.txt").write_text("probe")
            assert execute_tool(tool, {"path": "probe.txt"}, ctx).output == "probe"
        elif tool.kind == "list_files":
            (root / "probe.txt").write_text("probe")
            assert "probe.txt" in execute_tool(tool, {"pattern": "**/*.txt"}, ctx).output
        elif tool.kind == "search":
            (root / "probe.txt").write_text("needle")
            assert "probe.txt:1: needle" in execute_tool(tool, {"query": "needle"}, ctx).output`);
  }

  if (has.shell) {
    sections.push(String.raw`
# --------------------------------------------------------------------------
# Shell tools
# --------------------------------------------------------------------------


def test_sh_quote() -> None:
    assert sh_quote("plain") == "'plain'"
    assert sh_quote("it's") == "'it'\\''s'"


def test_render_command() -> None:
    assert render_command("npm test -- {{pattern}}", {}) == "npm test --"
    assert render_command("a {{x}} b {{y}}", {"y": 1}) == "a b '1'"
    assert render_command("echo {{msg}}", {"msg": "two  spaces"}) == "echo 'two  spaces'"


def test_arguments_cannot_inject(tmp_path: Path) -> None:
    payload = "$(echo pwned); echo 'x' && $HOME | cat"
    result = run_command(render_command("printf %s {{msg}}", {"msg": payload}), tmp_path, 10)
    assert result.output == "exit code: 0\n" + payload


def test_exit_code_and_timeout(tmp_path: Path) -> None:
    failed = run_command("echo out; echo err >&2; exit 3", tmp_path, 10)
    assert failed.is_error
    assert failed.output.startswith("exit code: 3\n")
    assert "out" in failed.output and "err" in failed.output
    slow = run_command("sleep 5", tmp_path, 0.3)
    assert slow.is_error and "timeout" in slow.output


def test_blocked_commands(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell, "BLOCKED_COMMANDS", ("rm -rf /",))
    result = shell.run_shell({"command": "rm -rf / {{x}}"}, {}, tmp_path)
    assert result.is_error and "blocked" in result.output`);
  }

  if (has.memory) {
    sections.push(String.raw`
# --------------------------------------------------------------------------
# Memory tool
# --------------------------------------------------------------------------


def test_memory_commands(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memories")
    assert not store.execute({"command": "view", "path": "/memories"}).is_error
    assert not store.execute({"command": "create", "path": "/memories/notes.md", "file_text": "a\nb\n"}).is_error
    assert store.execute({"command": "view", "path": "/memories/notes.md"}).output == "     1\ta\n     2\tb"
    assert not store.execute(
        {"command": "str_replace", "path": "/memories/notes.md", "old_str": "b", "new_str": "c"}
    ).is_error
    assert not store.execute(
        {"command": "insert", "path": "/memories/notes.md", "insert_line": 0, "insert_text": "top"}
    ).is_error
    assert (tmp_path / "memories" / "notes.md").read_text() == "top\na\nc\n"
    assert not store.execute(
        {"command": "rename", "old_path": "/memories/notes.md", "new_path": "/memories/x/n.md"}
    ).is_error
    assert not store.execute({"command": "delete", "path": "/memories/x/n.md"}).is_error
    assert store.execute({"command": "view", "path": "/memories/../outside"}).is_error
    assert store.execute({"command": "view", "path": "/etc/passwd"}).is_error
    assert store.execute({"command": "delete", "path": "/memories"}).is_error
    assert store.execute({"command": "explode", "path": "/memories"}).is_error`);
  }

  if (has.decisions) {
    sections.push(String.raw`
# --------------------------------------------------------------------------
# Decisions
# --------------------------------------------------------------------------

DECISIONS = [
    {"id": "repo-wide", "title": "Repo", "constraint": "Repo rule.", "status": "live", "governs": ["**"], "source": "CLAUDE.md:1"},
    {"id": "db", "title": "DB", "constraint": "DB rule.", "status": "live", "governs": ["src/db/**"], "source": "docs/adr/1.md"},
    {"id": "draft", "title": "Draft", "constraint": "Draft rule.", "status": "proposed", "governs": ["src/**"], "source": "AGENTS.md:3"},
    {"id": "old", "title": "Old", "constraint": "Old rule.", "status": "superseded", "governs": ["src/**"], "source": "docs/adr/0.md"},
]


def test_decision_globs() -> None:
    assert decisions.glob_matches("src/**", "src")
    assert decisions.glob_matches("src/*.py", "./src/a.py")
    assert not decisions.glob_matches("src/*.py", "src/a/b.py")
    assert decisions.glob_matches("src/db/**", "src")
    assert decisions.glob_matches("**/*.{py,pyi}", "a/b/c.pyi")


def test_get_decisions_serves_live_decisions_most_specific_first(tmp_path: Path) -> None:
    out = decisions.run_get_decisions(DECISIONS, {"paths": ["src/db/users.py"]}, tmp_path).output
    assert out.index("[db]") < out.index("[repo-wide]")
    assert "[draft]" not in out and "[old]" not in out
    with_proposed = decisions.run_get_decisions(DECISIONS, {"paths": ["src/x.py"], "include_proposed": True}, tmp_path).output
    assert "[draft]" in with_proposed and "[old]" not in with_proposed
    assert decisions.run_get_decisions(DECISIONS, {"paths": []}, tmp_path).is_error


def test_decisions_file_loads() -> None:
    assert isinstance(decisions.load_decisions(), list)`);
  }

  if (has.http) {
    sections.push(String.raw`
# --------------------------------------------------------------------------
# HTTP tools (request building only; nothing is sent)
# --------------------------------------------------------------------------


def test_encode_component() -> None:
    assert encode_component("a/b c?") == "a%2Fb%20c%3F"
    assert encode_component("-_.!~*'()") == "-_.!~*'()"
    assert encode_component(True) == "true"


def test_build_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DECREE_TEST_BASE", "http://api.test/")
    monkeypatch.setenv("DECREE_TEST_TOKEN", "tok")
    binding = {
        "method": "POST",
        "baseUrlEnv": "DECREE_TEST_BASE",
        "path": "/items/{id}",
        "queryParams": ["q"],
        "headerParams": ["X-Trace"],
        "auth": {"type": "bearer", "env": "DECREE_TEST_TOKEN"},
    }
    request = build_request(binding, {"id": "a/b", "q": "x", "X-Trace": "t", "name": "n"})
    assert request["url"] == "http://api.test/items/a%2Fb"
    assert request["params"] == {"q": "x"}
    assert request["headers"]["Authorization"] == "Bearer tok"
    assert request["headers"]["X-Trace"] == "t"
    assert request["json"] == {"name": "n"}
    get = build_request({**binding, "method": "GET"}, {"id": "1"})
    assert "json" not in get
    with_body = build_request({**binding, "bodyParam": "payload"}, {"id": "1", "payload": [1, 2]})
    assert with_body["json"] == [1, 2]


def test_build_request_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DECREE_TEST_MISSING", raising=False)
    with pytest.raises(ValueError):
        build_request({"baseUrlEnv": "DECREE_TEST_MISSING", "path": "/"}, {})
    with pytest.raises(ValueError):
        build_request({"defaultBaseUrl": "http://x", "path": "/items/{id}"}, {})`);
  }

  const needsOs = has.fs;
  return `${docstring(ctx, "Offline smoke tests for the tool executors. No API key or network needed.")}

from __future__ import annotations

${needsOs ? "import os\n" : ""}import re
from pathlib import Path

import pytest

from ${pkg}.tools import TOOLS, ToolContext, api_tool_params, execute_tool, needs_approval
from ${pkg}.tools import base
from ${pkg}.tools.registry import validate_input
${imports.join("\n")}
${sections.join("\n\n")}
`;
}
