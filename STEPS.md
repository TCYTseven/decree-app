# Steps only the maintainer can do

These need your npm or GitHub login. Everything else is done and on `main`.
Delete this file once the list is finished.

## 1. Fix the npm token (blocks publishing)

The first release failed at the last step with:

```
403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

1. npmjs.com → your avatar → **Access Tokens** → **Generate New Token** →
   **Granular Access Token**.
2. Packages and scopes: **Read and write**. Tick **Bypass two-factor
   authentication (2FA)**. Generate and copy it.
3. github.com/TCYTseven/decree-app → **Settings** → **Secrets and variables**
   → **Actions** → pencil next to `NPM_TOKEN` → paste → **Update secret**.

## 2. Publish v0.1.1

`main` is version 0.1.1. The old `v0.1.0` tag points at an older commit
without dashboard sync and never reached npm, so release from `main` instead.

1. **Releases** → **Draft a new release**.
2. **Choose a tag** → type `v0.1.1` → **Create new tag: v0.1.1 on publish**.
   Target: `main`.
3. Title: `v0.1.1: team decisions for coding agents, scoped to the files they touch`.
   Paste the 0.1.1 section of `CHANGELOG.md` as the description.
4. **Publish release**. The Release workflow runs tests, then publishes to npm
   in about 2 minutes.
5. Check it: `npx decree-harness@0.1.1 --version` prints `0.1.1`.

Optional: delete the failed `v0.1.0` release and tag (Releases → v0.1.0 →
Delete), so the releases page only shows what is on npm.

## 3. Turn on GitHub Pages (the Pages workflow fails on every push until you do)

**Settings** → **Pages** → **Build and deployment** → Source: **GitHub
Actions**. Then **Actions** → **Pages** → **Run workflow** on `main`, or push
any change under `site/`.

## 4. Dependabot pull requests

- **Bump the dev group** (TypeScript 7, vitest 5): close it. TypeScript 7
  removes the JavaScript compiler API the generator tests use, so it fails CI.
  `.github/dependabot.yml` now skips TypeScript major versions.
- **Bump commander to 15**: CI passes. Merge it if you want it.

## 5. After the first publish (optional)

On npmjs.com → `decree-harness` → **Settings** → **Trusted Publisher**, add
GitHub Actions with repository `TCYTseven/decree-app` and workflow
`release.yml`. Future releases then publish without a token, and you can
delete `NPM_TOKEN`.

## What was checked

On 2026-10-03, against `main`:

- Typecheck, 614 tests, build and the packed-tarball smoke test pass.
- The Decree dashboard's two Supabase migrations apply cleanly to Postgres 16.
- The real CLI against the real dashboard API routes (Next.js dev server, a
  local stand-in for Supabase's REST layer, and that Postgres database):
  `login --url` with browser approval, `whoami`, `push` (a new version on
  change, none when unchanged), an eval run upload, CI mode with
  `DECREE_TOKEN` + `DECREE_API_URL`, `logout`, and the errors for a missing
  URL and a revoked token.
- The dashboard frontend typechecks, lints and builds.
