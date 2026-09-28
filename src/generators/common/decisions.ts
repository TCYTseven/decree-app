/**
 * Ports of src/decisions/glob.ts + scope.ts for the generated targets. The TypeScript (typescript + mcp targets),
 * JavaScript (Claude Code skill script) and Python sources below implement the same matching, ranking and output
 * text as the runtime; test/decisions-ports.test.ts runs all of them against one table of cases. Change them together.
 *
 * The sources are String.raw templates: they must not contain backticks or "${".
 */
import type { Decision, HarnessSpec } from "../../core/types.js";
import { DEFAULT_DECISION_LIMIT } from "../../decisions/scope.js";

const KEY_ORDER: (keyof Decision)[] = ["id", "title", "constraint", "status", "governs", "source", "owner", "supersededBy", "rationale"];

/** The decisions data file every target ships next to its get_decisions implementation. */
export function decisionsJson(spec: Pick<HarnessSpec, "decisions">): string {
  const list = (spec.decisions ?? []).map((d) => {
    const out: Record<string, unknown> = {};
    for (const k of KEY_ORDER) if (d[k] !== undefined) out[k] = d[k];
    return out;
  });
  return `${JSON.stringify(list, null, 2)}\n`;
}

const TS_CORE = String.raw`export type DecisionStatus = "live" | "proposed" | "superseded";

export interface Decision {
  id: string;
  title: string;
  /** The rule an agent must follow. */
  constraint: string;
  status: DecisionStatus;
  /** Globs relative to the repo root; "**" is the whole repo. */
  governs: string[];
  source: string;
  owner?: string;
  supersededBy?: string;
  rationale?: string;
}

export const DEFAULT_LIMIT = ${DEFAULT_DECISION_LIMIT};
const META = /[*?{]/;
const STATUS_RANK: Record<DecisionStatus, number> = { live: 0, proposed: 1, superseded: 2 };

/** "./src//db\\users.ts/" -> "src/db/users.ts"; "." and "" -> "" (the repo root). */
export function normalizeRepoPath(input: string): string {
  return String(input)
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

function normalizeGlob(glob: string): string {
  return normalizeRepoPath(glob) || "**";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^$(){}|[\]\\/]/g, "\\$&");
}

/** "**" spans directories, "*" and "?" stay in one segment, {a,b} picks a literal; "dir/**" and "dir" also match dir. */
export function globToRegExp(glob: string): RegExp {
  const g = normalizeGlob(glob);
  if (!META.test(g)) return new RegExp("^" + escapeRegExp(g) + "(?:/.*)?$");
  let body = g;
  let tail = "";
  if (body.endsWith("/**")) {
    body = body.slice(0, -3);
    tail = "(?:/.*)?";
  }
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === "*" && body.charAt(i + 1) === "*") {
      if (body.charAt(i + 2) === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{" && body.indexOf("}", i) > i) {
      const end = body.indexOf("}", i);
      re += "(?:" + body.slice(i + 1, end).split(",").map(escapeRegExp).join("|") + ")";
      i = end;
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp("^" + re + tail + "$");
}

/** Length of the glob's literal prefix: more specific globs rank first. */
export function globSpecificity(glob: string): number {
  const g = normalizeGlob(glob);
  const idx = g.search(META);
  const prefix = idx < 0 ? g : g.slice(0, idx);
  return prefix.replace(/\/+$/, "").length;
}

/** The path matches the glob, or is a directory holding what the glob names. The repo root matches everything. */
export function globMatches(glob: string, path: string): boolean {
  const p = normalizeRepoPath(path);
  if (p === "") return true;
  const g = normalizeGlob(glob);
  if (globToRegExp(g).test(p)) return true;
  const idx = g.search(META);
  const prefix = idx < 0 ? g : g.slice(0, idx);
  return prefix.startsWith(p + "/");
}

/** Decisions governing any of the paths, most specific first; live before proposed; superseded never. */
export function rankDecisions(decisions: Decision[], paths: string[], includeProposed = false): Decision[] {
  const norm = paths.map(normalizeRepoPath);
  const scored: { d: Decision; score: number; index: number }[] = [];
  decisions.forEach((d, index) => {
    if (d.status !== "live" && !(includeProposed && d.status === "proposed")) return;
    let score = -1;
    for (const glob of d.governs) {
      const s = globSpecificity(glob);
      if (s <= score) continue;
      if (norm.some((p) => globMatches(glob, p))) score = s;
    }
    if (score >= 0) scored.push({ d, score, index });
  });
  scored.sort((a, b) => b.score - a.score || STATUS_RANK[a.d.status] - STATUS_RANK[b.d.status] || a.index - b.index);
  return scored.map((s) => s.d);
}

export function formatDecisions(decisions: Decision[], total: number, limit: number, includeProposed: boolean): string {
  if (decisions.length === 0) return "No " + (includeProposed ? "live or proposed " : "live ") + "decisions govern these paths.";
  const n = decisions.length;
  const lines = [n + " decision" + (n === 1 ? " governs" : "s govern") + " these paths, most specific first. Follow them, and cite the id when one constrains your change.", ""];
  for (const d of decisions) {
    lines.push("[" + d.id + "] " + d.title + (d.status === "proposed" ? " (proposed, not yet confirmed)" : ""));
    lines.push("Rule: " + d.constraint);
    lines.push("Governs: " + d.governs.join(", ") + " | Source: " + d.source);
    lines.push("");
  }
  const more = total - n;
  if (more > 0) lines.push(more + " more matched but were left out (limit " + limit + "). Pass narrower paths to see them.");
  return lines.join("\n").trimEnd();
}

function repoRelative(p: string, root: string): string {
  const posix = p.trim().replace(/\\/g, "/");
  if (!path.isAbsolute(p.trim())) return posix;
  const rel = path.relative(path.resolve(root), path.resolve(p.trim())).split(path.sep).join("/");
  return rel.startsWith("..") ? posix : rel;
}

/** The get_decisions tool: { paths: string[], include_proposed?: boolean } -> formatted decisions. */
export function runGetDecisions(decisions: Decision[], input: Record<string, unknown>, root: string, limit = DEFAULT_LIMIT): { output: string; isError: boolean } {
  const raw = input.paths;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string")) {
    return { output: 'Pass "paths": the files or directories you will read or change, e.g. ["src/db/users.ts"].', isError: true };
  }
  const includeProposed = input.include_proposed === true;
  const paths = (list as string[]).map((p) => repoRelative(p, root));
  const ranked = rankDecisions(decisions, paths, includeProposed);
  return { output: formatDecisions(ranked.slice(0, limit), ranked.length, limit, includeProposed), isError: false };
}

/** Read decisions.json; a missing file means no decisions. */
export function loadDecisions(file: string): Decision[] {
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error(file + " should hold an array of decisions.");
  return data as Decision[];
}
`;

/**
 * TypeScript module implementing get_decisions (the typescript target's src/tools/decisions.ts and the MCP
 * server's src/decisions.ts). `configImport` is the path of the target's config module, which exports
 * PACKAGE_DIR and PROJECT_ROOT.
 */
export function decisionsModuleTs(configImport: string): string {
  return String.raw`/**
 * get_decisions: the team decisions (ADRs, post-mortem lessons, repo rules) that govern the paths the agent is
 * about to touch. Data lives in decisions.json at the package root, written by decree-harness from decree.json.
 * Matching follows decree's runtime exactly: "**" spans directories, "*" and "?" stay within one segment.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_DIR, PROJECT_ROOT } from "${configImport}";

` + TS_CORE + String.raw`
export const DECISIONS_FILE = path.join(PACKAGE_DIR, "decisions.json");

/** Run get_decisions against decisions.json (re-read on every call, so edits apply without a restart). */
export async function getDecisions(input: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
  try {
    return runGetDecisions(loadDecisions(DECISIONS_FILE), input, PROJECT_ROOT);
  } catch (err) {
    return { output: "Could not read decisions: " + (err instanceof Error ? err.message : String(err)), isError: true };
  }
}
`;
}

/**
 * Stand-alone Node script for Claude Code (no dependencies): `node get-decisions.mjs [--proposed] <paths...>`
 * prints what get_decisions would return, reading decisions.json next to the script.
 */
export function decisionsScriptMjs(): string {
  const js = TS_CORE.replace(/^export type DecisionStatus[^\n]*\n\n/m, "")
    .replace(/^export interface Decision \{[\s\S]*?^\}\n\n/m, "")
    .replace(/: Record<DecisionStatus, number>/, "")
    .replace(/\(input: string\): string/g, "(input)")
    .replace(/\(glob: string\): string/g, "(glob)")
    .replace(/\(text: string\): string/g, "(text)")
    .replace(/\(glob: string\): RegExp/g, "(glob)")
    .replace(/\(glob: string\): number/g, "(glob)")
    .replace(/\(glob: string, path: string\): boolean/g, "(glob, path)")
    .replace(/\(decisions: Decision\[\], paths: string\[\], includeProposed = false\): Decision\[\]/g, "(decisions, paths, includeProposed = false)")
    .replace(/const scored: \{ d: Decision; score: number; index: number \}\[\] = \[\];/, "const scored = [];")
    .replace(/\(decisions: Decision\[\], total: number, limit: number, includeProposed: boolean\): string/, "(decisions, total, limit, includeProposed)")
    .replace(/\(p: string, root: string\): string/, "(p, root)")
    .replace(/\(decisions: Decision\[\], input: Record<string, unknown>, root: string, limit = DEFAULT_LIMIT\): \{ output: string; isError: boolean \}/, "(decisions, input, root, limit = DEFAULT_LIMIT)")
    .replace(/\(list as string\[\]\)/, "list")
    .replace(/\(file: string\): Decision\[\]/, "(file)")
    .replace(/const data: unknown = /, "const data = ")
    .replace(/return data as Decision\[\];/, "return data;")
    .replace(/^export /gm, "");
  return String.raw`#!/usr/bin/env node
// Generated by decree-harness from decree.json. Usage (from the repo root):
//   node .claude/skills/decisions/get-decisions.mjs [--proposed] <path> [<path> ...]
// Prints the live team decisions that govern those paths, most specific first. No dependencies.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

` + js + String.raw`
const args = process.argv.slice(2);
const includeProposed = args.includes("--proposed");
const paths = args.filter((a) => a !== "--proposed");
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "decisions.json");
const result = runGetDecisions(loadDecisions(file), { paths, include_proposed: includeProposed }, process.cwd());
process.stdout.write(result.output + "\n");
process.exitCode = result.isError ? 1 : 0;
`;
}

/** Python port: the python target's <pkg>/tools/decisions.py. `header` is the module docstring. */
export function decisionsModulePy(header: string): string {
  return header + String.raw`

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .base import ToolResult

#: decisions.json in the package, written by decree-harness from decree.json.
DECISIONS_FILE = Path(__file__).resolve().parent.parent / "decisions.json"
DEFAULT_LIMIT = ${DEFAULT_DECISION_LIMIT}
_META = re.compile(r"[*?{]")
_STATUS_RANK = {"live": 0, "proposed": 1, "superseded": 2}


def normalize_repo_path(value: str) -> str:
    """Normalize a repo path: "./src//db\\users.ts/" -> "src/db/users.ts"; "." and "" -> "" (the repo root)."""
    parts = str(value).strip().replace("\\", "/").split("/")
    return "/".join(seg for seg in parts if seg not in ("", "."))


def _normalize_glob(glob: str) -> str:
    return normalize_repo_path(glob) or "**"


def glob_to_regex(glob: str) -> re.Pattern[str]:
    """Glob to regex: "**" spans directories, "*" and "?" stay in one segment, {a,b} picks a literal.

    "dir/**" and a plain "dir" also match dir itself.

    Not fnmatch: its "*" crosses "/". Use with fullmatch().
    """
    g = _normalize_glob(glob)
    if not _META.search(g):
        return re.compile(re.escape(g) + "(?:/.*)?")
    body = g
    tail = ""
    if body.endswith("/**"):
        body = body[:-3]
        tail = "(?:/.*)?"
    out = ""
    i = 0
    while i < len(body):
        c = body[i]
        if c == "*" and body[i + 1 : i + 2] == "*":
            if body[i + 2 : i + 3] == "/":
                out += "(?:.*/)?"
                i += 2
            else:
                out += ".*"
                i += 1
        elif c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c == "{" and body.find("}", i) > i:
            end = body.find("}", i)
            out += "(?:" + "|".join(re.escape(part) for part in body[i + 1 : end].split(",")) + ")"
            i = end
        else:
            out += re.escape(c)
        i += 1
    return re.compile(out + tail)


def glob_specificity(glob: str) -> int:
    """Length of the glob's literal prefix: more specific globs rank first."""
    g = _normalize_glob(glob)
    m = _META.search(g)
    prefix = g if m is None else g[: m.start()]
    return len(prefix.rstrip("/"))


def glob_matches(glob: str, path: str) -> bool:
    """The path matches the glob, or is a directory holding what the glob names. The repo root matches everything."""
    p = normalize_repo_path(path)
    if p == "":
        return True
    g = _normalize_glob(glob)
    if glob_to_regex(g).fullmatch(p):
        return True
    m = _META.search(g)
    prefix = g if m is None else g[: m.start()]
    return prefix.startswith(p + "/")


def rank_decisions(decisions: list[dict[str, Any]], paths: list[str], include_proposed: bool = False) -> list[dict[str, Any]]:
    """Decisions governing any of the paths, most specific first; live before proposed; superseded never."""
    norm = [normalize_repo_path(p) for p in paths]
    scored: list[tuple[int, int, int, dict[str, Any]]] = []
    for index, d in enumerate(decisions):
        status = d.get("status")
        if status != "live" and not (include_proposed and status == "proposed"):
            continue
        score = -1
        for glob in d.get("governs") or []:
            s = glob_specificity(glob)
            if s <= score:
                continue
            if any(glob_matches(glob, p) for p in norm):
                score = s
        if score >= 0:
            scored.append((-score, _STATUS_RANK.get(str(status), 2), index, d))
    scored.sort(key=lambda item: item[:3])
    return [item[3] for item in scored]


def format_decisions(decisions: list[dict[str, Any]], total: int, limit: int, include_proposed: bool) -> str:
    if not decisions:
        return "No " + ("live or proposed " if include_proposed else "live ") + "decisions govern these paths."
    n = len(decisions)
    lines = [
        f"{n} decision{' governs' if n == 1 else 's govern'} these paths, most specific first. "
        "Follow them, and cite the id when one constrains your change.",
        "",
    ]
    for d in decisions:
        proposed = " (proposed, not yet confirmed)" if d.get("status") == "proposed" else ""
        lines.append(f"[{d['id']}] {d['title']}{proposed}")
        lines.append(f"Rule: {d['constraint']}")
        lines.append(f"Governs: {', '.join(d.get('governs') or [])} | Source: {d['source']}")
        lines.append("")
    more = total - n
    if more > 0:
        lines.append(f"{more} more matched but were left out (limit {limit}). Pass narrower paths to see them.")
    return "\n".join(lines).rstrip()


def _repo_relative(p: str, root: Path | str | None) -> str:
    posix = p.strip().replace("\\", "/")
    if root is None or not os.path.isabs(p.strip()):
        return posix
    rel = os.path.relpath(os.path.abspath(p.strip()), os.path.abspath(root)).replace(os.sep, "/")
    return posix if rel.startswith("..") else rel


def run_get_decisions(decisions: list[dict[str, Any]], args: dict[str, Any], root: Path | str | None, limit: int = DEFAULT_LIMIT) -> ToolResult:
    """The get_decisions tool: {"paths": [...], "include_proposed": bool} -> formatted decisions."""
    raw = args.get("paths")
    items = [raw] if isinstance(raw, str) else raw
    if not isinstance(items, list) or not items or not all(isinstance(p, str) for p in items):
        return ToolResult.error('Pass "paths": the files or directories you will read or change, e.g. ["src/db/users.ts"].')
    include_proposed = args.get("include_proposed") is True
    paths = [_repo_relative(p, root) for p in items]
    ranked = rank_decisions(decisions, paths, include_proposed)
    return ToolResult(format_decisions(ranked[:limit], len(ranked), limit, include_proposed))


def load_decisions(file: Path = DECISIONS_FILE) -> list[dict[str, Any]]:
    """Read decisions.json; a missing file means no decisions."""
    if not file.exists():
        return []
    data = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{file} should hold an array of decisions.")
    return [d for d in data if isinstance(d, dict)]


def get_decisions(args: dict[str, Any], project_root: Path) -> ToolResult:
    """Run get_decisions against decisions.json (re-read on every call, so edits apply without a restart)."""
    try:
        decisions = load_decisions()
    except (OSError, ValueError) as exc:
        return ToolResult.error(f"Could not read decisions: {exc}")
    return run_get_decisions(decisions, args, project_root)
`;
}
