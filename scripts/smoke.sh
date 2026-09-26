#!/usr/bin/env bash
# End-to-end smoke test of the *published* package: pack the tarball, check its contents,
# then install it the ways users do (local dependency, global, npx) outside the repo and
# run the CLI against a copy of a fixture project.
#
# Usage: scripts/smoke.sh [--no-build] [path/to/decree-harness-x.y.z.tgz]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
TGZ=""
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) TGZ="$arg" ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/decree-smoke.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# Keep npm quiet and self-contained; never touch the user's global prefix or cache.
export npm_config_cache="$WORK/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export NO_COLOR=1
unset ANTHROPIC_API_KEY || true

# ---------------------------------------------------------------- pack
if [[ -z "$TGZ" ]]; then
  if [[ "$BUILD" == 1 ]]; then
    step "build"
    (cd "$REPO" && npm run build --silent)
  fi
  step "pack"
  TGZ="$WORK/$(cd "$REPO" && npm pack --silent --pack-destination "$WORK" | tail -n1)"
fi
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"
[[ -f "$TGZ" ]] || fail "tarball not found: $TGZ"
echo "tarball: $TGZ ($(du -k "$TGZ" | cut -f1) KB)"

step "tarball contents"
tar tzf "$TGZ" | sort | tee "$WORK/contents.txt"
for required in package/package.json package/README.md package/LICENSE package/dist/cli.js package/dist/index.js package/dist/index.d.ts; do
  grep -qx "$required" "$WORK/contents.txt" || fail "missing from tarball: $required"
done
if grep -vE '^package/(package\.json|README\.md|LICENSE|dist/[^/]+\.(js|d\.ts))$' "$WORK/contents.txt"; then
  fail "unexpected files in tarball (listed above)"
fi
tar xzf "$TGZ" -C "$WORK" package/dist/cli.js
head -n1 "$WORK/package/dist/cli.js" | grep -qx '#!/usr/bin/env node' || fail "dist/cli.js has no shebang"

FIXTURE="$REPO/test/fixtures/express-openapi"
[[ -d "$FIXTURE" ]] || fail "fixture missing: $FIXTURE"

check_init_output() {
  local dir="$1"
  for f in decree.json agent/README.md agent/harness.md agent/evals.json \
           agent/typescript/package.json agent/python agent/mcp-server/package.json \
           agent/claude-code; do
    [[ -e "$dir/$f" ]] || fail "init did not produce $f in $dir"
  done
}

# ---------------------------------------------------------------- local install
step "local install into a fresh project"
APP="$WORK/app"
mkdir -p "$APP"
(cd "$APP" && npm init -y >/dev/null && npm install --no-package-lock "$TGZ" >/dev/null)
[[ -x "$APP/node_modules/decree-harness/dist/cli.js" ]] || fail "installed dist/cli.js is not executable"
(cd "$APP" && npx --no-install decree-harness --version)
(cd "$APP" && npx --no-install decree --version)
(cd "$APP" && npx --no-install decree-harness --help) | grep -q "Usage: decree-harness" || fail "--help output unexpected"

step "init --yes --offline --targets all (local install)"
cp -R "$FIXTURE" "$WORK/proj-local"
(cd "$APP" && npx --no-install decree-harness init --yes --offline --targets all \
  --goal "Operate the API and run tests" --cwd "$WORK/proj-local")
check_init_output "$WORK/proj-local"
(cd "$APP" && npx --no-install decree-harness doctor --cwd "$WORK/proj-local") || echo "(doctor reported issues; non-fatal)"

step "programmatic API"
(cd "$APP" && node --input-type=module -e '
  const m = await import("decree-harness");
  for (const name of ["scanProject", "planHarness", "generateTargets"]) {
    if (typeof m[name] !== "function") { console.error("missing export:", name); process.exit(1); }
  }
  console.log("exports ok:", Object.keys(m).length);
')

# ---------------------------------------------------------------- global install
step "global install (temp prefix)"
PREFIX="$WORK/global"
npm install -g --prefix "$PREFIX" "$TGZ" >/dev/null
BIN="$PREFIX/bin"
[[ -x "$BIN/decree-harness" ]] || fail "global bin decree-harness missing"
[[ -x "$BIN/decree" ]] || fail "global bin decree missing"
"$BIN/decree-harness" --version
"$BIN/decree" --help >/dev/null
cp -R "$FIXTURE" "$WORK/proj-global"
(cd "$WORK/proj-global" && "$BIN/decree" init --yes --offline --targets all >/dev/null)
check_init_output "$WORK/proj-global"

# ---------------------------------------------------------------- npx flow
# `npx --yes file:<tgz>` resolves the bin the same way `npx decree-harness` does from the
# registry (the bin named after the package, even though the package ships two bins).
# A bare absolute path without `file:` is treated by npm as a shell command, not a package.
step "npx --yes file:<tarball> from an empty directory"
EMPTY="$WORK/empty"
mkdir -p "$EMPTY"
(cd "$EMPTY" && npx --yes "file:$TGZ" --help) | grep -q "Usage: decree-harness" || fail "npx --help output unexpected"
(cd "$EMPTY" && npx --yes --package "file:$TGZ" decree --version)
cp -R "$FIXTURE" "$WORK/proj-npx"
(cd "$EMPTY" && npx --yes "file:$TGZ" init --yes --offline --targets typescript,mcp --cwd "$WORK/proj-npx" >/dev/null)
[[ -f "$WORK/proj-npx/decree.json" ]] || fail "npx init did not write decree.json"

step "smoke test passed"
