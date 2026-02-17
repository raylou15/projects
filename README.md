# Rays Games Monorepo

This repository is organized as a scalable multi-game monorepo.

## Layout

- `apps/rays-games/`
  - `server/` — production backend hub (`pm2` process name stays `rays-games`)
  - `games/<slug>/server/` — optional per-game server modules
- `apps/context-clues/client/` — Context Clues frontend (Vite)
- `apps/context-clues/server/` — staging/reference server tree
- `apps/trivia/client/` — starter stub frontend
- `apps/trivia/server/` — starter stub server module path
- `deploy/`
  - `games.manifest.json` — deploy inventory + defaults
  - `deploy-master.sh` — manifest-driven master deploy
  - `deploy-game.sh` — generic per-game frontend deploy helper
  - `caddy/` + `cmds/` — server-installed infrastructure scripts/config

## URL mapping

- Root (`/`) remains unchanged for backward compatibility.
- Game frontends are served at `/g/<slug>/`.
  - Context Clues: `/g/context-clues/`
  - Trivia stub: `/g/trivia/` (when enabled/deployed)
- API and sockets are unchanged:
  - `/api/*` -> backend `127.0.0.1:3000`
  - `/ws*` -> backend WebSocket endpoint
- Legal URLs remain available:
  - `/terms/`
  - `/privacy/`

## Server path mapping (production)

- PM2 process name: `rays-games`
- Backend runtime root: `/root/rays-games`
- Backend entrypoint: `/root/rays-games/server/server.js`
- Frontend web root: `/var/www/rays-games`
- Caddy config root: `/etc/caddy`
- Installed deploy commands: `/usr/local/bin`

## Environment variables (production)

Store server secrets in `/root/rays-games/.env`.

Discord OAuth is now namespaced per game (with legacy fallback support):

- Context Clues token exchange uses:
  - `CONTEXT_CLUES_DISCORD_CLIENT_ID`
  - `CONTEXT_CLUES_DISCORD_CLIENT_SECRET`
- Trivia token exchange uses:
  - `TRIVIA_DISCORD_CLIENT_ID`
  - `TRIVIA_DISCORD_CLIENT_SECRET`

Trivia backend also requires:

- `DATABASE_URL`

## Manifest-driven deployment

Primary command:

```bash
deploy-rays-games
```

Master deploy behavior (`deploy/deploy-master.sh`):

1. Validates repo + manifest.
2. `git fetch` + `reset --hard origin/<branch>`.
3. Syncs `deploy/caddy` and `deploy/cmds`; installs:
   - `/usr/local/bin/deploy-rays-games`
   - `/usr/local/bin/deploy-game`
4. Syncs backend (`apps/rays-games/` -> `/root/rays-games/`) while preserving:
   - `/root/rays-games/.env`
   - `/root/rays-games/server/data/glove.*`
   - `/root/rays-games/server/data/embeddings.trimmed.json`
5. Generates per-game baby scripts:
   - `/usr/local/bin/deploy-<slug>` -> calls `deploy-game <slug>`
6. Deploys each enabled game frontend from manifest.
7. Restarts PM2 once at end only when backend changed.
8. Validates and reloads Caddy once.
9. Runs health checks:
   - `curl -fsS http://127.0.0.1:3000/health`
   - `curl -fsS https://rays-games.loseyourip.com/api/health`

Supported master flags:

- `--dry-run`
- `--only <slug>`
- `--skip-backend`
- `--skip-frontend`

## Per-game deploy helper

```bash
deploy-game <slug> [--restart] [--no-build] [--clean-publish]
```

- Reads game metadata from `deploy/games.manifest.json`.
- Builds `apps/<slug>/client` (unless `--no-build`).
- Publishes to `/var/www/rays-games/<publish_subdir>`.
- Optional standalone PM2 restart with `--restart`.

## Add a new game

1. Create frontend at `apps/<slug>/client`.
2. (Optional) create backend module at `apps/rays-games/games/<slug>/server/index.js`.
3. Add manifest entry in `deploy/games.manifest.json`:
   - `slug`
   - `client_path`
   - `publish_subdir` (`g/<slug>`)
   - `enabled`
4. Run `deploy-rays-games`.

## Backend sync guardrail

- Production source-of-truth remains `apps/rays-games/server`.
- Staging/reference server remains `apps/context-clues/server`.
- Guardrail check:

```bash
node scripts/check-server-sync.mjs
```
