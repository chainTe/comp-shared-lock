#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$ROOT/plugins/comp-shared-lock/skills/comp-shared-lock"
ESBUILD="$ROOT/frontend/node_modules/.bin/esbuild"
DOWNLOADS="$ROOT/frontend/public/downloads"
BANNER='import { createRequire as __compCreateRequire } from "node:module"; const require = __compCreateRequire(import.meta.url);'

if [[ ! -x "$ESBUILD" ]]; then
  echo "frontend dependencies are missing; run npm ci in frontend" >&2
  exit 2
fi

cp "$ROOT/deployment.json" "$SKILL/deployment.json"
"$ESBUILD" "$ROOT/scripts/comp-query.mjs" \
  --bundle --platform=node --format=esm --target=node20 \
  --banner:js="$BANNER" --outfile="$SKILL/scripts/comp-query.mjs"
"$ESBUILD" "$ROOT/scripts/comp-post.mjs" \
  --bundle --platform=node --format=esm --target=node20 \
  --banner:js="$BANNER" --outfile="$SKILL/scripts/comp-post.mjs"
chmod +x "$SKILL/scripts/comp-query.mjs" "$SKILL/scripts/comp-post.mjs"

mkdir -p "$DOWNLOADS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$SKILL" "$TMP/comp-shared-lock"
find "$TMP/comp-shared-lock" -exec touch -t 198001010000 {} +
(
  cd "$TMP"
  zip -X -q -r "$DOWNLOADS/comp-shared-lock-skill.zip" comp-shared-lock
)

shasum -a 256 "$DOWNLOADS/comp-shared-lock-skill.zip"
