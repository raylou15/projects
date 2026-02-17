#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST_PATH="${MANIFEST_PATH:-$REPO_DIR/deploy/games.manifest.json}"

slug=""
restart_pm2=false
no_build=false
clean_publish=false

usage() {
  cat <<USAGE
Usage: deploy-game <slug> [--restart] [--no-build] [--clean-publish]

Options:
  --restart        Restart pm2 process after publish (standalone mode)
  --no-build       Skip npm build and only republish dist/
  --clean-publish  Use rsync --delete for target directory cleanup
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

slug="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart) restart_pm2=true ;;
    --no-build) no_build=true ;;
    --clean-publish) clean_publish=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
  shift
done

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Manifest not found: $MANIFEST_PATH" >&2
  exit 1
fi

mapfile -t manifest_values < <(python3 - "$MANIFEST_PATH" "$slug" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
slug = sys.argv[2]
game = next((g for g in manifest.get('games', []) if g.get('slug') == slug), None)
if not game:
    sys.exit(2)
print(manifest.get('web_root', '/var/www/rays-games'))
print(manifest.get('backend_root', '/root/rays-games'))
print(manifest.get('pm2_name', 'rays-games'))
print(manifest.get('domain', 'https://rays-games.loseyourip.com'))
print(game.get('client_path', ''))
print(game.get('publish_subdir', ''))
print('true' if game.get('enabled', False) else 'false')
print('true' if game.get('legacy_root_publish', False) else 'false')
print(game.get('vite_client_id_env', ''))
PY
)

if [[ ${#manifest_values[@]} -eq 0 ]]; then
  echo "Game slug '$slug' not found in manifest." >&2
  exit 1
fi

WEB_ROOT="${manifest_values[0]}"
BACKEND_ROOT="${manifest_values[1]}"
PM2_NAME="${manifest_values[2]}"
DOMAIN="${manifest_values[3]}"
CLIENT_PATH_REL="${manifest_values[4]}"
PUBLISH_SUBDIR="${manifest_values[5]}"
ENABLED="${manifest_values[6]}"
LEGACY_ROOT_PUBLISH="${manifest_values[7]}"
VITE_CLIENT_ID_ENV="${manifest_values[8]}"

if [[ -z "$CLIENT_PATH_REL" || -z "$PUBLISH_SUBDIR" ]]; then
  echo "Manifest entry for '$slug' is missing client_path or publish_subdir." >&2
  exit 1
fi

CLIENT_DIR="$REPO_DIR/$CLIENT_PATH_REL"
PUBLISH_DIR="$WEB_ROOT/$PUBLISH_SUBDIR"
ENV_FILE="$REPO_DIR/.env"

declare -A SAFE_ENV=()

parse_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line="${raw_line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      SAFE_ENV["$key"]="$value"
    fi
  done < "$env_file"
}

if [[ ! -d "$CLIENT_DIR" ]]; then
  echo "Client directory does not exist: $CLIENT_DIR" >&2
  exit 1
fi

if [[ "$ENABLED" != "true" ]]; then
  echo "Warning: '$slug' is disabled in manifest; continuing because it was explicitly requested."
fi

if [[ "$no_build" != "true" ]]; then
  parse_env_file "$ENV_FILE"

  pushd "$CLIENT_DIR" >/dev/null

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi

  if [[ -n "$VITE_CLIENT_ID_ENV" ]]; then
    if [[ -z "${SAFE_ENV[$VITE_CLIENT_ID_ENV]:-}" ]]; then
      echo "Missing required env var '$VITE_CLIENT_ID_ENV' for slug '$slug' in $ENV_FILE" >&2
      exit 1
    fi
    export VITE_DISCORD_CLIENT_ID="${SAFE_ENV[$VITE_CLIENT_ID_ENV]}"
  fi

  if [[ -n "${SAFE_ENV[VITE_BACKEND_PORT]:-}" ]]; then
    export VITE_BACKEND_PORT="${SAFE_ENV[VITE_BACKEND_PORT]}"
  fi

  npm run build
  popd >/dev/null
fi

if [[ ! -d "$CLIENT_DIR/dist" ]]; then
  echo "Build output missing: $CLIENT_DIR/dist" >&2
  exit 1
fi

mkdir -p "$PUBLISH_DIR"
RSYNC_FLAGS=(-av)
if [[ "$clean_publish" == "true" ]]; then
  RSYNC_FLAGS+=(--delete)
fi
rsync "${RSYNC_FLAGS[@]}" "$CLIENT_DIR/dist/" "$PUBLISH_DIR/"

if [[ "$LEGACY_ROOT_PUBLISH" == "true" ]]; then
  mkdir -p "$WEB_ROOT"
  rsync -av "$CLIENT_DIR/dist/" "$WEB_ROOT/"
fi

bash "$REPO_DIR/deploy/smoke-test.sh" "$slug"

if [[ "$restart_pm2" == "true" ]]; then
  pushd "$BACKEND_ROOT/server" >/dev/null
  pm2 restart "$PM2_NAME" --update-env
  pm2 save
  popd >/dev/null
fi

echo "Deployed frontend '$slug' to $PUBLISH_DIR"
if [[ "$LEGACY_ROOT_PUBLISH" == "true" ]]; then
  echo "Also published '$slug' to legacy root: $WEB_ROOT"
fi
