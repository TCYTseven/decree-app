# Changelog

All notable changes to decree-harness are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `decree-harness mcp`: serves `get_decisions` from `decree.json` over stdio
  for Claude Code, Cursor and other MCP clients, with nothing to generate
  first. It re-reads `decree.json` on every call.

### Removed

- `login`, `logout`, `whoami`, `push` and `eval --push`, which synced
  `decree.json` to a hosted dashboard. decree now runs entirely locally.

## 0.1.0

First version.

- Repo scanner: languages, frameworks, scripts, OpenAPI specs, routes, env
  vars, database models.
- Planner: offline heuristics, or Claude with an architect and critic pass.
- Targets: TypeScript agent, Python agent, MCP server, Claude Code.
- `chat`, `run`, `eval`, `refine`, `doctor`, `preview`.
- Decisions: extraction from ADRs, rules files and post-mortems, `live` /
  `proposed` / `superseded` status, `governs` globs, and the `get_decisions`
  tool in every target.
