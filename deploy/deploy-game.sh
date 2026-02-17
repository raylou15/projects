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
print(game.get('client_path', ''))
print(game.get('publish_subdir', ''))
print('true' if game.get('enabled', False) else 'false')
print('true' if game.get('legacy_root_publish', False) else 'false')
PY
)

if [[ ${#manifest_values[@]} -eq 0 ]]; then
  echo "Game slug '$slug' not found in manifest." >&2
  exit 1
fi

WEB_ROOT="${manifest_values[0]}"
BACKEND_ROOT="${manifest_values[1]}"
PM2_NAME="${manifest_values[2]}"
CLIENT_PATH_REL="${manifest_values[3]}"
PUBLISH_SUBDIR="${manifest_values[4]}"
ENABLED="${manifest_values[5]}"
LEGACY_ROOT_PUBLISH="${manifest_values[6]}"

if [[ -z "$CLIENT_PATH_REL" || -z "$PUBLISH_SUBDIR" ]]; then
  echo "Manifest entry for '$slug' is missing client_path or publish_subdir." >&2
  exit 1
fi

CLIENT_DIR="$REPO_DIR/$CLIENT_PATH_REL"
PUBLISH_DIR="$WEB_ROOT/$PUBLISH_SUBDIR"

if [[ ! -d "$CLIENT_DIR" ]]; then
  echo "Client directory does not exist: $CLIENT_DIR" >&2
  exit 1
fi

if [[ "$ENABLED" != "true" ]]; then
  echo "Warning: '$slug' is disabled in manifest; continuing because it was explicitly requested."
fi


resolve_vite_client_id_for_slug() {
  local target_slug="$1"
  case "$target_slug" in
    context-clues)
      echo "${CONTEXT_CLUES_DISCORD_CLIENT_ID:-}"
      ;;
    trivia)
      echo "${TRIVIA_DISCORD_CLIENT_ID:-}"
      ;;
    *)
      echo ""
      ;;
  esac
}

if [[ "$no_build" != "true" ]]; then
  vite_client_id="$(resolve_vite_client_id_for_slug "$slug")"
  if [[ -z "${vite_client_id}" ]]; then
    echo "Missing VITE_DISCORD_CLIENT_ID build input for '$slug'." >&2
    case "$slug" in
      context-clues)
        echo "Set CONTEXT_CLUES_DISCORD_CLIENT_ID in the deploy environment before building." >&2
        ;;
      trivia)
        echo "Set TRIVIA_DISCORD_CLIENT_ID in the deploy environment before building." >&2
        ;;
      *)
        echo "Set a game-specific Discord client ID and map it in deploy/deploy-game.sh." >&2
        ;;
    esac
    exit 1
  fi

  pushd "$CLIENT_DIR" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  VITE_DISCORD_CLIENT_ID="$vite_client_id" npm run build
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
