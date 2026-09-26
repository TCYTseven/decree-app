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

```
decree.json                 the harness spec (edit it, then `decree-harness generate`)
agent/
  README.md                 overview of the generated harness
  harness.md                design doc: prompt, every tool, safety flags, planner notes
  evals.json                eval cases
  .env.example
  typescript/               standalone agent (Anthropic TS SDK): CLI, REPL, evals
  python/                   standalone agent (Anthropic Python SDK): CLI, REPL, evals, pytest
  mcp-server/               MCP server exposing the tools to Claude Code, Claude Desktop, Cursor
  claude-code/              CLAUDE.md, .claude/agents, skills, slash commands, settings.json, .mcp.json
```

Pick targets with `--targets typescript,python,mcp,claude-code` (or `all`).

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
| `generate` | Render `decree.json` into code (`--targets`, `--out`, `--clean`, `--dry-run`) |
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

Node 18.17 or newer.

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
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module layout and the
tool semantics every target implements.

## License

MIT
