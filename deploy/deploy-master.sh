#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST_PATH="$REPO_DIR/deploy/games.manifest.json"

DRY_RUN=false
ONLY_SLUG=""
SKIP_BACKEND=false
SKIP_FRONTEND=false

usage() {
  cat <<USAGE
Usage: deploy-rays-games [--dry-run] [--only <slug>] [--skip-backend] [--skip-frontend]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --only)
      shift
      ONLY_SLUG="${1:-}"
      [[ -n "$ONLY_SLUG" ]] || { echo "--only requires a slug"; exit 1; }
      ;;
    --skip-backend) SKIP_BACKEND=true ;;
    --skip-frontend) SKIP_FRONTEND=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
  shift
done

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

[[ -d "$REPO_DIR/.git" ]] || { echo "REPO_DIR is not a git repo: $REPO_DIR" >&2; exit 1; }
[[ -f "$MANIFEST_PATH" ]] || { echo "Missing manifest: $MANIFEST_PATH" >&2; exit 1; }

mapfile -t meta < <(python3 - "$MANIFEST_PATH" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
print(m.get('branch_default','main'))
print(m.get('web_root','/var/www/rays-games'))
print(m.get('backend_root','/root/rays-games'))
print(m.get('pm2_name','rays-games'))
print(m.get('domain','https://rays-games.loseyourip.com'))
PY
)

BRANCH="${BRANCH:-${meta[0]}}"
BACKEND_ROOT="${meta[2]}"
PM2_NAME="${meta[3]}"
DOMAIN="${meta[4]}"

pushd "$REPO_DIR" >/dev/null
run_cmd git fetch --all --prune
run_cmd git checkout "$BRANCH"
run_cmd git reset --hard "origin/$BRANCH"
popd >/dev/null

run_cmd rsync -av --delete "$REPO_DIR/deploy/caddy/" /etc/caddy/
run_cmd rsync -av "$REPO_DIR/deploy/cmds/" /usr/local/bin/
run_cmd install -m 755 "$REPO_DIR/deploy/deploy-master.sh" /usr/local/bin/deploy-rays-games
run_cmd install -m 755 "$REPO_DIR/deploy/deploy-game.sh" /usr/local/bin/deploy-game
run_cmd chmod +x /usr/local/bin/deploy-*

backend_changed=0
if [[ "$SKIP_BACKEND" != "true" ]]; then
  run_cmd mkdir -p "$BACKEND_ROOT"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] rsync backend -> $BACKEND_ROOT"
    backend_changed=1
  else
    rsync_output="$(rsync -av --delete --itemize-changes \
      --exclude '.git/' \
      --exclude 'node_modules/' \
      --exclude 'dist/' \
      --exclude '.env' \
      --exclude '.env.*' \
      --exclude 'server/data/glove.*' \
      --exclude 'server/data/embeddings.trimmed.json' \
      "$REPO_DIR/apps/rays-games/" "$BACKEND_ROOT/")"
    echo "$rsync_output"
    if echo "$rsync_output" | grep -Eq '^[<>ch\*]'; then
      backend_changed=1
    fi
  fi
fi

enabled_games=()
if [[ "$SKIP_FRONTEND" != "true" ]]; then
  mapfile -t enabled_games < <(python3 - "$MANIFEST_PATH" "$ONLY_SLUG" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
only=sys.argv[2].strip()
for g in m.get('games',[]):
    if not g.get('enabled'):
        continue
    slug=g.get('slug','').strip()
    if only and slug!=only:
        continue
    if slug:
        print(slug)
PY
)

  if [[ -n "$ONLY_SLUG" && ${#enabled_games[@]} -eq 0 ]]; then
    echo "No enabled manifest game matched --only $ONLY_SLUG" >&2
    exit 1
  fi

  for slug in "${enabled_games[@]}"; do
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[dry-run] write /usr/local/bin/deploy-$slug"
    else
      cat > "/usr/local/bin/deploy-$slug" <<BABY
#!/usr/bin/env bash
exec /usr/local/bin/deploy-game '$slug' "\$@"
BABY
      chmod +x "/usr/local/bin/deploy-$slug"
    fi
    run_cmd env REPO_DIR="$REPO_DIR" /usr/local/bin/deploy-game "$slug"
  done
fi

if [[ "$backend_changed" -eq 1 && "$SKIP_BACKEND" != "true" ]]; then
  run_cmd pm2 restart "$PM2_NAME" --update-env
  run_cmd pm2 save
fi

run_cmd caddy validate --config /etc/caddy/Caddyfile
run_cmd systemctl reload caddy
run_cmd curl -fsS http://127.0.0.1:3000/health
run_cmd curl -fsS "$DOMAIN/api/health"

cat <<SUMMARY
Deploy summary:
- repo: $REPO_DIR
- branch: $BRANCH
- backend: $([[ "$SKIP_BACKEND" == "true" ]] && echo skipped || echo deployed)
- backend restart: $([[ "$backend_changed" -eq 1 ]] && echo yes || echo no)
- frontend: $([[ "$SKIP_FRONTEND" == "true" ]] && echo skipped || echo deployed)
- games: ${enabled_games[*]:-none}
SUMMARY
