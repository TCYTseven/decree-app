# decree-harness architecture

`npx decree-harness` scans a codebase and generates an agent harness for it:
a system prompt, a tool surface bound to the project's real API endpoints,
scripts and files, subagents, guardrails, and evals. The output is runnable
code in several targets. Claude (Anthropic API) designs the harness; an
offline heuristic planner covers runs without an API key.

## Pipeline

```
scanProject(root)            src/scanner    -> ProjectProfile   (deterministic, no network)
planHarness(profile, opts)   src/planner    -> HarnessSpec      (Claude, or offline heuristics)
validateSpec(json)           src/core/spec  -> normalized HarnessSpec
generateTargets(spec, ...)   src/generators -> GeneratedFile[]  (pure rendering)
runAgent(spec, opts)         src/runtime    -> live agent loop against Claude with local tool execution
runEvals(spec, opts)         src/eval       -> EvalResult[]
CLI                          src/cli.ts + src/commands + src/ui
```

All contracts live in `src/core/types.ts`. Do not change them without
coordinating: every module depends on them.

## Files on disk (in the user's project)

| Path | What |
|---|---|
| `decree.json` | The HarnessSpec. Editable source of truth (like mintlify's `docs.json`). |
| `.decree/profile.json` | Last scan result. |
| `.decree/manifest.json` | sha256 of every file decree last generated; used to avoid clobbering user edits. |
| `.decree/memory/` | Backing store for the `memory` tool when running via `decree-harness chat/run`. |
| `.decree/runs/` | JSONL transcripts of `run`/`chat`/`eval` sessions. |
| `agent/` (default out dir) | Generated targets: `agent/typescript`, `agent/python`, `agent/mcp-server`, `agent/claude-code`, plus `agent/README.md`, `agent/harness.md`, `agent/evals.json`, `agent/.env.example` and the `agent/.decree-generated` marker (see list_files / search below). |

## Models

- Planner and generated harness default: `claude-opus-5` (adaptive thinking, effort `high`).
- Subagents default: `claude-sonnet-5`.
- Never append date suffixes to model ids.
- Pricing per 1M tokens (input/output): opus-5 5/25, opus-5-5 4/20, fable-5-1 10/50, fable-5 10/50, opus-4-8/4-7/4-6 5/25,
  sonnet-5 2/10, sonnet-4-6 3/15, haiku-4-5 1/5. Cache reads 0.1x input, cache writes 1.25x input.

Anthropic SDK reference docs (read these instead of guessing SDK shapes):
`/tmp/claude-0/bundled-skills/2.1.283/aae5969f9aac2361136afc1396c8cb57/claude-api/`
(`typescript/claude-api/*.md`, `python/claude-api/*.md`, `shared/tool-use-concepts.md`,
`shared/agent-design.md`, `shared/prompt-caching.md`). The installed TS SDK is
`@anthropic-ai/sdk@0.128` in `node_modules`; its `.d.ts` files are the final word.

## Tool semantics (runtime AND every generated target must match)

Every `ToolSpec` has a `kind`. Implementations:

- **http**: base = `process.env[http.baseUrlEnv] ?? http.defaultBaseUrl` (error if neither).
  URL = base (trailing `/` trimmed) + `http.path` with each `{name}` replaced by
  `encodeURIComponent(input[name])`. `queryParams` keys present in input go to the query string;
  `headerParams` keys go to headers. Body (JSON) for POST/PUT/PATCH/DELETE: `input[bodyParam]` when
  `bodyParam` is set, else every input key not consumed as path/query/header (omit body if empty).
  Auth: `bearer` -> `Authorization: Bearer ${env[auth.env]}`; `header` -> `${auth.header}: ${env[auth.env]}`.
  Params are read from the input's own properties only (`Object.hasOwn`; never the prototype).
  Redirects: fetched with `redirect: "manual"` (httpx: `follow_redirects=False`); at most 5 redirects
  are followed and only when the `Location` stays on the same origin (scheme + host + port), so auth
  headers never leave the API's origin. 303, and 301/302 after POST, continue as GET without a body.
  A cross-origin (or 6th) redirect is not followed: the 3xx response is returned with a
  `[redirect to <url> not followed: different origin]` line after the status line.
  Timeout 60s. Result text: `HTTP <status> <statusText>\n<body>`; body redacted (see Output hygiene)
  and then truncated to 50,000 chars (append `\n…[truncated N chars]`). `isError` when status >= 400
  or network failure.
- **shell**: `{{param}}` placeholders replaced with the POSIX single-quote-escaped input value;
  missing/undefined optional params become an empty string, then collapse repeated spaces.
  Placeholders must be bare top-level shell words. `validateSpec` rewrites `"{{x}}"` / `'{{x}}'` to
  `{{x}}` and rejects a placeholder inside quotes, backticks, `${...}` or a `#` comment, or right after
  `$`, `\` or `$(`; every renderer re-checks the template with the same quote-tracking scan and refuses
  (isError, `unsafe command template: ...`) instead of substituting. A substituted value that starts
  with `-` is refused (`parameter values may not start with '-'`) unless the input schema property sets
  `"x-allow-flags": true`. Params are read from own properties only.
  Refuse (isError) if the final command contains any `guardrails.blockedCommands` substring.
  Run with `/bin/sh -c` in `projectRoot/shell.cwd`, timeout `shell.timeoutMs ?? 120000`.
  Result: `exit code: <n>\n<stdout+stderr>`; output is redacted first, then the LAST 30,000 chars are kept.
  `isError` when exit code != 0 or timeout.
- **read_file / write_file / list_files / search**: all paths resolved against
  `projectRoot/fs.root`; refuse anything that escapes it (lexical check + realpath when it exists)
  and anything outside `guardrails.allowedPaths`. `read_file` returns content (max `fs.maxBytes ?? 200000`
  bytes, then `\n…[truncated N bytes]`). It reads up to `maxBytes + 4096` bytes, redacts (see Output hygiene),
  and only then truncates to `maxBytes`; when the file was not read to the end, the last 4096 redacted bytes are
  always cut as well (they may end in the start of a secret that continues past what was read). `write_file` mkdir -p's and returns `wrote <n> bytes to <path>`.
  `list_files` globs (`pattern`), ignores `node_modules`, `.git`, `dist`, `.decree`, `.venv`, `venv`, `__pycache__`,
  `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.tox`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache` (same list for `search`), max 500 results,
  one per line. `list_files` and `search` also skip every directory below the tool root that contains a
  `.decree-generated` file: `generateCommon` writes that marker at the root of the output dir (`agent/`), so the
  agent's file tools never wander into the generated harness. Checked when descending into a directory, result
  cached per directory. The scanner (`src/scanner/walk.ts`) skips marked directories too. `search` takes `query` (regex) + optional `glob`, skips binary files and files > 1MB,
  max 200 matches formatted `path:line: text`.
- **web_search**: Anthropic server tool `{ type: "web_search_20260209", name: "web_search", max_uses: 5 }`.
- **web_fetch**: Anthropic server tool `{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 }`.
- **memory**: Anthropic memory tool `{ type: "memory_20250818", name: "memory" }`, client-executed,
  commands `view | create | str_replace | insert | delete | rename`, confined to a memory directory
  (`.decree/memory` for the built-in runtime, `./memories` in generated projects).

Server tools (`web_search`, `web_fetch`) and `memory` have empty `inputSchema` in the spec; they are
declared with their Anthropic type instead of a custom schema.

**decree-private schema keywords.** Keys starting with `x-` (`x-allow-flags`, `x-json-string`, ...) are decree's
own annotations. They are stripped, at any depth, from every `input_schema` sent to the API
(`stripPrivateKeywords` in `src/core/json-schema.ts`: runtime `buildToolParams`, the generated TypeScript and
Python registries, and the MCP server's zod schemas). Property names, `$defs` names and instance data (`enum`,
`const`, `default`, `examples`, `required`) are not keywords and are kept, so a header param named `x-request-id`
survives. Targets carry what they need from these keywords in their binding data instead (shell `allowFlags`).

### Approval

```
needsApproval(tool) =
  approvalMode == "never"       -> false
  approvalMode == "always"      -> !tool.readOnly || tool.requiresApproval
  approvalMode == "destructive" -> tool.requiresApproval || tool.destructive
```
A denied call returns a `tool_result` with `is_error: true` and content
`The user declined this action. Ask them how to proceed.`

### Subagents

Each `SubagentSpec` becomes a client tool on the main agent named
`delegate_to_<name with - replaced by _>` with input `{ task: string }` (description = subagent
description). Calling it runs a nested agent loop with the subagent's `systemPrompt`, only its listed
tools, model `subagent.model ?? spec.model.subagentId`, effort `subagent.effort ?? "medium"`,
at most `guardrails.maxTurns` turns, and returns the subagent's final text as the tool result.

### Output hygiene

Any occurrence of the value of an env var listed in `guardrails.redactEnv` is replaced in tool output
with `[REDACTED:<NAME>]` before it is sent to the model. Values shorter than 4 chars are ignored;
longer values are replaced first. http and shell tools redact the raw output BEFORE truncating it, so a
cut can never leave part of a secret behind.

Scanner excerpts (`keyFiles[].excerpt`, and the README as sent to the planner / saved in
`.decree/profile.json`) mask hardcoded secrets with `[REDACTED]` (`src/core/mask-secrets.ts`).

Claude Code target: `Bash(<prefix>:*)` rules whose prefix has fewer than 2 words or is a generic runner
(`sh -c`, `npm run`, `npx`, `make`, `uv run`, ...) go to `ask`, never `allow`.

### Model request shape

- Streaming (`client.messages.stream` / `client.beta.messages.stream`) with `.finalMessage()`.
- `max_tokens = guardrails.maxOutputTokensPerTurn`.
- `thinking: { type: "adaptive" }` when `model.thinking == "adaptive"`; omit otherwise.
- `output_config: { effort: model.effort }`.
- System prompt as a text block; when `context.caching`, put `cache_control: { type: "ephemeral" }` on the
  system block and set top-level automatic `cache_control` for the conversation tail.
- Tool list order is deterministic (spec order) so the cache prefix is stable.
- `context.compaction` -> beta endpoint, beta `compact-2026-01-12`, `context_management.edits: [{ type: "compact_20260112" }]`.
  Always append the full `response.content` (never just text) to history.
- `context.contextEditing` -> beta `context-management-2025-06-27`, edit `{ type: "clear_tool_uses_20250919" }`.
- Handle `stop_reason`: `end_turn` (done), `tool_use` (run tools, return ALL results in ONE user message,
  run independent read-only tools concurrently), `pause_turn` (append assistant content, continue),
  `max_tokens` (stop, do not run truncated tool calls), `refusal` (stop, report `stop_details`).
- Loop ends at `guardrails.maxTurns` or once estimated cost exceeds `guardrails.maxCostUsd`.

## Conventions

- ESM TypeScript, `module: NodeNext`: relative imports end in `.js`.
- Node >= 20.12. No `__dirname` (use `fileURLToPath(import.meta.url)`).
- Dependencies available: `@anthropic-ai/sdk`, `commander`, `@clack/prompts`, `picocolors`, `zod` (v4),
  `yaml`, `fast-glob`, `ignore`. Dev: `typescript`, `tsup`, `vitest`, `@types/node`.
- Tests: vitest, `test/<area>.test.ts`; fixtures in `test/fixtures/`; shared helpers in
  `test/helpers/` (`sampleSpec()`, `sampleProfile()`). Tests never hit the network.
- Generated code must be correct as generated: generator tests render `sampleSpec()` to a temp dir and
  the target's own toolchain must accept it (tsc / py_compile).
