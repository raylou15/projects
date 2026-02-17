#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST_PATH="${MANIFEST_PATH:-$REPO_DIR/deploy/games.manifest.json}"

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "Usage: smoke-test <slug>" >&2
  exit 1
fi

mapfile -t vals < <(python3 - "$MANIFEST_PATH" "$slug" <<'PY'
import json, re, sys
manifest = json.load(open(sys.argv[1], encoding='utf-8'))
slug = sys.argv[2]
game = next((g for g in manifest.get('games', []) if g.get('slug') == slug), None)
if not game:
    sys.exit(2)
domain = manifest.get('domain', 'https://rays-games.loseyourip.com').rstrip('/')
subdir = (game.get('publish_subdir') or '').strip('/')
print(domain)
print(subdir)
PY
)

if [[ ${#vals[@]} -lt 2 ]]; then
  echo "[smoke:$slug] manifest lookup failed" >&2
  exit 1
fi

DOMAIN="${vals[0]}"
SUBDIR="${vals[1]}"
BASE_URL="$DOMAIN/$SUBDIR"
HTML_FILE="$(mktemp)"

cleanup() {
  rm -f "$HTML_FILE" "${JS_FILE:-}" "${CSS_FILE:-}" "${HEALTH_FILE:-}"
}
trap cleanup EXIT

echo "[smoke:$slug] checking $BASE_URL/"
curl -fsSL "$BASE_URL/" -o "$HTML_FILE"

JS_PATH="$(python3 - "$HTML_FILE" "$SUBDIR" <<'PY'
import re, sys
html=open(sys.argv[1], encoding='utf-8').read()
subdir=sys.argv[2]
pat=rf'<script[^>]*type=["\']module["\'][^>]*src=["\'](/'+re.escape(subdir)+r'/assets/[^"\']+\.js)["\']'
m=re.search(pat, html, flags=re.I)
print(m.group(1) if m else '')
PY
)"

if [[ -z "$JS_PATH" ]]; then
  echo "[smoke:$slug] FAIL: no module JS asset reference found in HTML" >&2
  exit 1
fi

CSS_PATH="$(python3 - "$HTML_FILE" "$SUBDIR" <<'PY'
import re, sys
html=open(sys.argv[1], encoding='utf-8').read()
subdir=sys.argv[2]
pat=rf'<link[^>]*rel=["\']stylesheet["\'][^>]*href=["\'](/'+re.escape(subdir)+r'/assets/[^"\']+\.css)["\']'
m=re.search(pat, html, flags=re.I)
print(m.group(1) if m else '')
PY
)"

echo "[smoke:$slug] js asset: $JS_PATH"
if [[ -n "$CSS_PATH" ]]; then
  echo "[smoke:$slug] css asset: $CSS_PATH"
else
  echo "[smoke:$slug] css asset: (none referenced)"
fi

JS_FILE="$(mktemp)"
JS_HEADERS="$(curl -fsSIL "$DOMAIN$JS_PATH")"
JS_STATUS="$(printf '%s\n' "$JS_HEADERS" | awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}')"
JS_CT="$(printf '%s\n' "$JS_HEADERS" | awk -F': *' 'tolower($1)=="content-type" {print tolower($2)}' | tail -n1)"
curl -fsSL "$DOMAIN$JS_PATH" -o "$JS_FILE"
JS_HEAD32="$(head -c 32 "$JS_FILE" | tr '[:upper:]' '[:lower:]')"

if [[ "$JS_STATUS" != "200" ]]; then
  echo "[smoke:$slug] FAIL: JS status=$JS_STATUS url=$DOMAIN$JS_PATH" >&2
  exit 1
fi
if [[ "$JS_CT" != *javascript* ]]; then
  echo "[smoke:$slug] FAIL: JS content-type is '$JS_CT'" >&2
  exit 1
fi
if [[ "$JS_HEAD32" == "<!doctype html"* ]]; then
  echo "[smoke:$slug] FAIL: JS payload begins with HTML doctype (routing regression)" >&2
  exit 1
fi

if [[ -n "$CSS_PATH" ]]; then
  CSS_FILE="$(mktemp)"
  CSS_HEADERS="$(curl -fsSIL "$DOMAIN$CSS_PATH")"
  CSS_STATUS="$(printf '%s\n' "$CSS_HEADERS" | awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}')"
  CSS_CT="$(printf '%s\n' "$CSS_HEADERS" | awk -F': *' 'tolower($1)=="content-type" {print tolower($2)}' | tail -n1)"
  curl -fsSL "$DOMAIN$CSS_PATH" -o "$CSS_FILE"

  if [[ "$CSS_STATUS" != "200" ]]; then
    echo "[smoke:$slug] FAIL: CSS status=$CSS_STATUS url=$DOMAIN$CSS_PATH" >&2
    exit 1
  fi
  if [[ "$CSS_CT" != *text/css* ]]; then
    echo "[smoke:$slug] FAIL: CSS content-type is '$CSS_CT'" >&2
    exit 1
  fi
fi

HEALTH_FILE="$(mktemp)"
curl -fsSL "$DOMAIN/api/health" -o "$HEALTH_FILE"
python3 - "$HEALTH_FILE" <<'PY'
import json,sys
obj=json.load(open(sys.argv[1],encoding='utf-8'))
if obj.get('ok') is not True:
    raise SystemExit(1)
PY

echo "[smoke:$slug] PASS"
