# decree-harness

Generate an agent harness for your codebase in one command.

```bash
npx decree-harness
```

decree scans your repo (API routes, OpenAPI specs, scripts, env vars, database
models, docs), has Claude design a harness for the goal you describe, and writes
runnable code: a system prompt, a tool surface bound to your real endpoints and
scripts, subagents, guardrails, and evals. You can chat with the agent right
away from the terminal, then ship the generated code.

It works the way mintlify works for API docs: point it at a codebase, get a
generated artifact, keep one config file (`decree.json`) as the source of truth,
and regenerate whenever the code changes.

## What you get

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

Pick targets with `--targets typescript,python,mcp,claude-code` (or `all`).

## Example

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

## How it plans

1. **Scan** (local, no network). Languages, frameworks, package manager, scripts
   (package.json, Makefile, pyproject, justfile, Taskfile), OpenAPI/Swagger specs,
   routes found in code (Express, Fastify, Hono, NestJS, Next.js, FastAPI, Flask,
   Django, Gin, Echo, Chi, Rails, and more), env var names, database models, README,
   existing agent config.
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
| `schema` | Print the JSON schema for `decree.json` |

Useful flags: `--yes` (non-interactive), `--offline`, `--model <id>`,
`--goal "<text>"`, `--no-critique`, `-C <dir>`.

## Setup

Node 20.12 or newer.

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

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # tsup -> dist/
node dist/cli.js --help
npm run smoke     # pack the tarball, install it (local, global, npx) and run init on a fixture
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module layout and the
tool semantics every target implements.

## License

MIT
