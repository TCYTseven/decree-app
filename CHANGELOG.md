# Changelog

All notable changes to decree-harness are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.1

First version published to npm (0.1.0 was tagged but never published).

### Added

- `decree-harness mcp`: serves `get_decisions` from `decree.json` over stdio
  for Claude Code, Cursor and other MCP clients, with nothing to generate
  first. It re-reads `decree.json` on every call.

### Changed

- `login`, `logout`, `whoami`, `push` and `eval --push` sync to a Decree
  dashboard you host yourself. trydecree.com doesn't host dashboards yet, so
  there is no default URL: pass `login --url <dashboard>` or set
  `DECREE_API_URL`. Everything else runs locally with no account.

### Fixed

- A rejected or revoked token now says to run `login --url <your dashboard>`
  instead of the dashboard's older `decree login` hint, which fails without a
  URL.

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
