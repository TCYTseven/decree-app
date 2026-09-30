# decree

[![CI](https://github.com/TCYTseven/decree-app/actions/workflows/ci.yml/badge.svg)](https://github.com/TCYTseven/decree-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give coding agents your team's decisions, scoped to the files they touch.

Your repo already records decisions in ADRs, post-mortems, `CLAUDE.md`,
`AGENTS.md` and Cursor rules. Agents either never see them or get all of them
in every session. decree extracts them into `decree.json`, gives each one a
status (`live`, `proposed`, `superseded`) and a scope (`governs` globs), and
serves an agent only the live decisions that govern the paths it is about to
change.

It also generates a full agent harness for a codebase (system prompt, tools
bound to your real endpoints and scripts, guardrails, evals) for TypeScript,
Python, MCP and Claude Code. See [Generate an agent harness](#generate-an-agent-harness).

## Quick start: decisions in Claude Code

No API key needed. In your repo:

```bash
npx decree-harness plan --yes --offline      # scan the repo and extract decisions into decree.json
npx decree-harness decisions                 # review them
npx decree-harness decisions confirm <id>    # proposed -> live, once a person agrees it holds
npx decree-harness decisions for src/db/users.ts   # exactly what an agent gets for that path

claude mcp add decree -- npx -y decree-harness mcp
```

Claude Code now has a `get_decisions` tool. Before an edit it passes the paths
it will touch and gets back at most 8 live decisions whose globs match, most
specific first. The server re-reads `decree.json` on every call, so `confirm`
and `supersede` take effect without a restart. Commit `decree.json` and review
changes to it in pull requests like any other file.

### Other MCP clients

Any client that runs stdio servers works. For Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "decree": { "command": "npx", "args": ["-y", "decree-harness", "mcp"] }
  }
}
```

The server reads `decree.json` from its working directory. If your client
starts servers somewhere else, pass the repo: `"args": ["-y", "decree-harness", "mcp", "-C", "/path/to/repo"]`.

## How decisions work

`plan` and `init` read the decisions your repo already writes down and store
them in `decree.json` under `decisions` (`decisions extract` re-reads them later):

- **ADRs** in `docs/adr`, `docs/adrs`, `docs/decisions`, `doc/adr`, `adr/`,
  `architecture/decisions`, `decisions/`, and any `adr/` directory. The title
  comes from the first heading (an `ADR-0003:` prefix is dropped), the status
  from a `Status:` line, a Status section or frontmatter, the rule from the
  Decision section, and the rationale from Context. `Superseded by [ADR-0007](...)`
  links the two records.
- **Rules files**: `CLAUDE.md`, `AGENTS.md` (also nested ones, which govern their
  own directory), `.cursor/rules/*.mdc` (its `globs:` become the scope),
  `.cursorrules` and `.github/copilot-instructions.md`. Bullets that state a rule
  ("Never ...", "Always ...", "... must ...", "Use X instead of Y") become
  decisions. Sections other tools manage, such as gstack's, are skipped.
- **Post-mortems** in `docs/postmortems`, `postmortems/`, `incidents/`: rule-like
  bullets under Action items, Lessons, Follow-ups and Prevention.

Each decision has an `id`, a `constraint` (the rule), a `status` and `governs`
globs. The scope comes from frontmatter (`governs:`), then from repo paths the
text mentions that exist, then from the directory of a nested rules file, and
otherwise covers the whole repo (`**`).

| Status | Meaning |
|---|---|
| `live` | Accepted. The agent follows it. ADRs marked Accepted start here. |
| `proposed` | Extracted but not confirmed. Rules and post-mortem lessons start here. Not served by default. |
| `superseded` | Replaced or rejected. Kept for history, never served. |

```bash
decree-harness decisions                    # table of id, status, governs, source (--status, --json)
decree-harness decisions extract            # re-read the repo; keeps your statuses, adds new ones, flags missing sources
decree-harness decisions for src/db/users.ts   # exactly what the agent gets for that path
decree-harness decisions confirm <id...>    # proposed -> live
decree-harness decisions supersede <id> --by <new-id>   # retire one (without --by: rejected)
```

Commands that change decisions regenerate the harness when it was generated
before (`--no-generate` to skip).

`decree-harness mcp` serves them directly from `decree.json`. When you also
generate a harness, it gets a read-only `get_decisions` tool
and one line in its system prompt: call it with the files you are about to
change, follow what it returns, cite the decision id, and stop if a request
conflicts with a live decision. The tool returns at most 8 live decisions whose
globs match those paths, most specific first, with repo-wide ones last. Every
target implements it with the same matching: the TypeScript and Python agents
and the MCP server read a `decisions.json` shipped with them, and Claude Code
calls the MCP tool (or, without the MCP target, a small
`.claude/skills/decisions` script that needs only Node). The generated
`CLAUDE.md` says how to look decisions up and lists none of them.

Why scope them: a flat context file loads every rule into every session,
whether or not it applies to the task. A February 2026 ETH Zurich study
([Gloaguen et al., arXiv 2602.11988](https://arxiv.org/abs/2602.11988)) found
that repository context files did not generally improve task success on real
coding tasks and raised inference cost by over 20% on average. Serving only
the decisions that govern the touched paths keeps the context small and
relevant.


## Generate an agent harness

```bash
npx decree-harness
```

decree scans your repo (API routes, OpenAPI specs, scripts, env vars, database
models, docs), has Claude design a harness for the goal you describe, and writes
runnable code: a system prompt, a tool surface bound to your real endpoints and
scripts, subagents, guardrails, and evals. You can chat with the agent right
away from the terminal, then ship the generated code. When the repo has
decisions, every target gets `get_decisions` too.

`decree.json` is the source of truth, the way `docs.json` is for Mintlify: edit
it, regenerate, and keep it in the repo. The generated code is disposable. The
decision record in `decree.json` is the part that lives on.

### What you get

`npx decree-harness init --yes --offline --targets all` on
[`test/fixtures/express-openapi`](test/fixtures/express-openapi) (an Express +
OpenAPI orders service) writes:

```
decree.json                 the harness spec (edit it, then `decree-harness generate`)
.decree/                    profile.json (last scan), manifest.json (hashes of generated files), schema.json
agent/
  README.md                 overview of the generated harness and how to run each target
  harness.md                design doc: prompt, every tool, safety flags, planner notes
  evals.json                eval cases
  .env.example              env vars the tools need
  .decree-generated         marker: decree's file tools and scanner skip this directory
  typescript/               standalone agent (Anthropic TS SDK): src/{agent,cli,loop,tools,...}.ts, CLI, REPL, evals
  python/                   standalone agent (Anthropic Python SDK): acme_orders_agent/, pyproject.toml, pytest tests/
  mcp-server/               MCP server (src/server.ts, src/tools.ts) for Claude Code, Claude Desktop, Cursor
  claude-code/              CLAUDE.md, .claude/{agents,commands,skills,settings.json}, .mcp.json
```

When the repo has decisions, each target also gets `get_decisions` and a
`decisions.json` (see [Decisions](#decisions)).

Pick targets with `--targets typescript,python,mcp,claude-code` (or `all`).

### Example

`decree-harness tools --no-color` for that fixture (offline plan, 100 columns;
narrower terminals drop the Kind column, wider ones add Source):

```
Acme Orders Agent · 18 tools · asks before 5 risky tools
┌─────────────────────┬────────────┬─────────────────────────────┐
│ Tool                │ Kind       │ Binds to                    │
├─────────────────────┼────────────┼─────────────────────────────┤
│ ● check_health      │ http       │ GET /health                 │
│ ● list_orders       │ http       │ GET /orders                 │
│ ◆ create_order      │ http       │ POST /orders                │
│ ● get_order         │ http       │ GET /orders/{id}            │
│ ■ delete_order      │ http       │ DELETE /orders/{id}         │
│ ■ cancel_order      │ http       │ POST /orders/{id}/cancel    │
│ ● list_customers    │ http       │ GET /customers              │
│ ● get_customer      │ http       │ GET /customers/{customerId} │
│ ● list_order_events │ http       │ GET /orders/{id}/events     │
│ ◆ run_tests         │ shell      │ npm run test -- {{filter}}  │
│ ◆ run_lint          │ shell      │ npm run lint                │
│ ◆ run_build         │ shell      │ npm run build               │
│ ■ run_deploy        │ shell      │ npm run deploy              │
│ ■ run_db_migrate    │ shell      │ npm run db:migrate          │
│ ■ run_db_seed       │ shell      │ npm run db:seed             │
│ ● read_file         │ read_file  │ .                           │
│ ● list_files        │ list_files │ .                           │
│ ● search_code       │ search     │ .                           │
└─────────────────────┴────────────┴─────────────────────────────┘
 ● read-only   ◆ writes   ■ destructive, asks first
```

### How it plans

1. **Scan** (local, no network). Languages, frameworks, package manager, scripts
   (package.json, Makefile, pyproject, justfile, Taskfile), OpenAPI/Swagger specs,
   routes found in code (Express, Fastify, Hono, NestJS, Next.js, FastAPI, Flask,
   Django, Gin, Echo, Chi, Rails, and more), env var names, database models, README,
   existing agent config, and decisions (see above).
2. **Architect** (Claude). Designs the tool surface, system prompt, subagents,
   guardrails, context strategy, and evals, grounded in candidate tools derived
   from the scan so bindings point at endpoints and scripts that exist.
3. **Critic** (Claude). Scores the draft on grounding, tool descriptions, safety
   flags, prompt quality, eval coverage and redundancy, then revises it.
4. **Grounding pass** (code). Drops tools bound to endpoints that don't exist,
   forces approval on destructive tools, keeps subagents read-only, validates the
   spec.

Without an API key, `--offline` uses a heuristic planner that produces the same
kind of spec from the scan alone.

## Commands

| Command | What it does |
|---|---|
| `decree-harness` / `init` | Interactive wizard: scan, ask for the goal and targets, plan, generate |
| `scan [--json]` | Scan only; writes `.decree/profile.json` |
| `plan` | Scan and plan; writes `decree.json` only |
| `generate` | Render `decree.json` into code (`--targets`, `--out`, `--clean`, `--dry-run`, `--json`) |
| `refine "<feedback>"` | Change the harness in plain English, e.g. `refine "make it read-only"` |
| `chat` | Talk to the agent in your terminal; tools run locally with approval prompts |
| `run "<prompt>"` | One-shot run (`--json` for machine output) |
| `eval` | Run the eval cases and report pass/fail (tools run in dry-run mode by default) |
| `doctor` | Check Node, API key, `decree.json`, required env vars, generated output |
| `tools` | List the tools in `decree.json` |
| `decisions` | List, extract, confirm and supersede team decisions; `decisions for <path>` shows what the agent gets |
| `mcp` | Serve `get_decisions` from `decree.json` over stdio for Claude Code, Cursor or any MCP client |
| `schema` | Print the JSON schema for `decree.json` |
| `preview` | Local dashboard to inspect, edit and try the harness |

Useful flags: `--yes` (non-interactive), `--offline`, `--model <id>`,
`--goal "<text>"`, `--no-critique`, `-C <dir>`.

## Setup

Node 20.12 or newer. Decisions, `mcp`, `scan`, `generate` and every
`--offline` command run locally with no API key. Planning with Claude, `refine`,
`chat`, `run` and `eval` need one:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # or put it in .env
npx decree-harness
```

The planner and generated harness default to `claude-opus-5` with adaptive
thinking; subagents default to `claude-sonnet-5`. Change either in
`decree.json` or with `--model`.

## Safety model

- Every tool carries `readOnly`, `destructive` and `requiresApproval` flags.
  Destructive tools always require a human yes (`guardrails.approvalMode`).
- File tools are confined to `guardrails.allowedPaths`, including symlink escapes.
- Shell tools substitute parameters with POSIX quoting and refuse
  `guardrails.blockedCommands`.
- Values of secret env vars are redacted from tool output before the model sees them.
- `maxTurns` and `maxCostUsd` cap every run.
- decree never overwrites generated files you edited (tracked in
  `.decree/manifest.json`) unless you pass `--force`.

## Programmatic API

```ts
import { scanProject, planHarness, generateTargets, runAgent, createLLM } from "decree-harness";

const profile = await scanProject(process.cwd());
const spec = await planHarness(profile, { goal: "Triage failing tests", targets: ["typescript"], llm: createLLM() });
const files = generateTargets(spec, spec.targets, { outDir: "agent", decreeVersion: "0.1.0" });
```

## Contributing

Bug reports, fixes and new scanners are welcome. Decision extraction that got a
repo wrong is the most useful report you can file: open an issue with the
source file (or a trimmed copy) and what you expected. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and conventions, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module layout and the
tool semantics every target implements.

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # tsup -> dist/
node dist/cli.js --help
npm run smoke     # pack the tarball, install it (local, global, npx) and run init on a fixture
```

Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
