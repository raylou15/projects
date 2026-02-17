#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://rays-games.loseyourip.com}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cc_index="$ROOT_DIR/apps/context-clues/client/dist/index.html"
trivia_index="$ROOT_DIR/apps/trivia/client/dist/index.html"

echo "== Dist base asset references =="
for file in "$cc_index" "$trivia_index"; do
  if [[ -f "$file" ]]; then
    echo "-- $file"
    rg -o '/(context-clues|trivia)/assets/[^"'"'"'\ ]+' "$file" | head -n 5 || true
  else
    echo "-- $file (missing; run build first)"
  fi
done

echo
echo "== HTTP checks =="
curl -sS -o /tmp/diag_context.html -w "GET /context-clues/ -> %{http_code}
" "$BASE_URL/context-clues/"
asset_path="$(grep -oE '/context-clues/assets/[^" ]+\.js' /tmp/diag_context.html | head -n1 || true)"
if [[ -n "$asset_path" ]]; then
  curl -sSI -o /tmp/diag_asset.head -w "HEAD ${asset_path} -> %{http_code}
" "$BASE_URL$asset_path"
else
  echo "HEAD <context-clues js asset> -> skipped (asset not found in HTML)"
fi

curl -sS -D /tmp/diag_token.headers -o /tmp/diag_token.body   -H 'content-type: application/json'   -X POST "$BASE_URL/token"   --data '{"game":"context-clues"}' || true
echo "POST /token status: $(awk 'NR==1{print $2}' /tmp/diag_token.headers)"
echo "POST /token x-powered-by: $(awk 'tolower($1)=="x-powered-by:"{print $2}' /tmp/diag_token.headers | tr -d '')"

echo
echo "== WebSocket probe (node ws client) =="
node "$ROOT_DIR/scripts/ws-probe.mjs" "$BASE_URL"

echo
echo "== Suggested log checks =="
echo "sudo tail -f /var/log/caddy/rays-games-access.log | rg '(/ws|101|token|client-log)'"
echo "pm2 logs rays-games --lines 120"
