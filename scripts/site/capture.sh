#!/usr/bin/env bash
# Recapture real CLI output used by the site, then regenerate site/.
# Usage: bash scripts/site/capture.sh   (needs Python >= 3.12 for gen.py)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/scripts/site/out"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
cd "$ROOT"
npm run build >/dev/null
CLI="node $ROOT/dist/cli.js"
cp -r test/fixtures/express-openapi "$TMP/demo"
export COLUMNS=100
$CLI init --yes --offline --targets all -C "$TMP/demo" --no-color | sed "s#$TMP/demo#.#g" > "$OUT/init.txt"
$CLI tools -C "$TMP/demo" --no-color > "$OUT/tools.txt"
$CLI doctor -C "$TMP/demo" --no-color > "$OUT/doctor.txt" || true
$CLI --help --no-color > "$OUT/help.txt"
for c in init scan plan generate refine chat run eval doctor tools decisions mcp schema preview; do
  $CLI "$c" --help --no-color > "$OUT/help-$c.txt" 2>/dev/null || rm -f "$OUT/help-$c.txt"
done
$CLI schema > "$OUT/schema.json"
cp "$TMP/demo/decree.json" "$OUT/demo-decree.json"
PY="$(command -v python3.13 || command -v python3.12 || command -v python3)"
"$PY" scripts/site/gen.py
echo "site regenerated"
