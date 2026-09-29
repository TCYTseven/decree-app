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

It also collects the decisions your team already made (ADRs, post-mortem lessons,
rules in CLAUDE.md and AGENTS.md) and gives the agent only the ones that govern
the files it is about to change.

`decree.json` is the source of truth, the way `docs.json` is for Mintlify: edit
it, regenerate, and keep it in the repo. The generated code is disposable. The
decision record in `decree.json` is the part that lives on.

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

When the repo has decisions, each target also gets `get_decisions` and a
`decisions.json` (see [Decisions](#decisions)).

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

## Decisions

`init` reads the decisions your repo already writes down and stores them in
`decree.json` under `decisions`:

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

When a spec has decisions, the harness gets a read-only `get_decisions` tool
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
whether or not it applies to the task. A 2026 ETH Zurich study found that flat
`AGENTS.md` files lowered agent task success and raised cost by more than 20%.
Serving only the decisions that govern the touched paths keeps the context
small and relevant.

## How it plans

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
| `schema` | Print the JSON schema for `decree.json` |
| `preview` | Local dashboard to inspect, edit and try the harness |
| `login` / `logout` / `whoami` | Connect this machine to [trydecree.com/dashboard](https://trydecree.com/dashboard) |
| `push` | Sync `decree.json` to the dashboard (`-m "<note>"`, `--dry-run`, `--json`) |

Useful flags: `--yes` (non-interactive), `--offline`, `--model <id>`,
`--goal "<text>"`, `--no-critique`, `-C <dir>`.

## Dashboard sync

`decree.json` stays the source of truth in your repo; the dashboard at
[trydecree.com/dashboard](https://trydecree.com/dashboard) keeps every version
of it and the eval runs against each version.

```bash
npx decree-harness login        # approve the code in your browser
npx decree-harness push         # a changed spec becomes a new version
npx decree-harness eval --push  # attach the run to the version it tested
```

`login` creates a token on your machine and sends only its hash; you approve
the login in the browser and the token is saved to
`~/.config/decree/credentials.json` (mode 600). In CI, create a token under
**API tokens** and set it as `DECREE_TOKEN`:

```yaml
- run: npx -y decree-harness push
  env:
    DECREE_TOKEN: ${{ secrets.DECREE_TOKEN }}
```

What is uploaded: the spec (without `$schema`, defaults of secret env vars, or
credentials in base URLs), git commit/branch/remote (credentials stripped),
and for evals the scores, check results, tool names and a shortened, masked
final answer. Tool inputs and outputs never leave your machine.
`DECREE_API_URL` points the CLI at another deployment (e.g.
`http://localhost:3000`).

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
