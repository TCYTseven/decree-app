# Contributing to decree

Thanks for helping. Issues and pull requests are both welcome, and small ones
get merged fastest.

## Reporting a problem

- **Extraction got it wrong.** decree missed a decision, invented one, gave it
  the wrong status, or scoped it to the wrong paths. Use the "Decision
  extraction" issue template and include the source file (or a trimmed copy)
  plus what you expected in `decree.json`. These reports turn directly into
  fixtures under `test/fixtures/`.
- **Bug.** Include `npx decree-harness --version`, your Node version, the
  command you ran, and the output with `--verbose`.
- **Security.** Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

Node 20.12 or newer. Python 3.11+ is optional; the Python target's tests are
skipped without it.

```bash
git clone https://github.com/TCYTseven/decree-app.git
cd decree-app
npm install
npm test            # vitest, no network
npm run typecheck
npm run build       # tsup -> dist/
node dist/cli.js --help
```

Try your change on a fixture without touching a real repo:

```bash
cp -r test/fixtures/decisions-repo /tmp/demo
node dist/cli.js plan --yes --offline -C /tmp/demo
node dist/cli.js decisions -C /tmp/demo
```

`npm run smoke` packs the tarball and installs it the ways users do (local,
global, npx). CI runs it on every pull request.

## Where things live

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the pipeline, module layout
and the tool semantics every generated target must match. The short version:

| Area | Path |
|---|---|
| Decision extraction, scoping, glob matching | `src/decisions/` |
| MCP server (`decree-harness mcp`) | `src/mcp/` |
| Repo scanner (routes, OpenAPI, scripts, env, models) | `src/scanner/` |
| Planner (heuristic and Claude) | `src/planner/` |
| Code generators per target | `src/generators/` |
| CLI commands | `src/commands/` |
| Docs site (generated) | `site/`, built by `scripts/site/` |

## Conventions

- ESM TypeScript with `module: NodeNext`: relative imports end in `.js`.
- Tests go in `test/<area>.test.ts`, fixtures in `test/fixtures/`. Tests never
  hit the network; use the fakes in `test/helpers/`.
- `get_decisions` is implemented four times: the runtime (`src/decisions/`)
  and ports in `src/generators/common/decisions.ts` (TypeScript, JavaScript,
  Python). Change them together. `test/decisions-ports.test.ts` runs all of
  them against one table of cases.
- Generated code must be correct as generated. Generator tests render a spec
  and run the target's own toolchain on it.
- Snapshot tests cover CLI output. If you change output on purpose, update
  them with `npx vitest run -u` and check the diff.
- Run `npm run typecheck && npm test` before you push.

## Docs site

`site/` is generated from real CLI output. After changing command help or the
`decree.json` schema, regenerate it:

```bash
bash scripts/site/capture.sh
```

Timing numbers in `scripts/site/out/init.txt` and `site/index.html` change on
every run; commit those only when something else in them changed.

## Pull requests

- One change per pull request, with a test that fails without it.
- Describe what changed and how you checked it.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything
  a user would notice.

## Releasing (maintainers)

1. Set the new version in `package.json`, `src/version.ts` and
   `scripts/site/gen.py` (a test checks they match), and move the
   "Unreleased" changelog entries under it.
2. Merge to `main`, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow typechecks, tests, smoke-tests and publishes to npm
   with provenance. It needs an `NPM_TOKEN` repository secret. Tags with a
   hyphen (`v0.2.0-beta.1`) publish under the `next` dist-tag.
