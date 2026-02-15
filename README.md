# Context Clues Runbook

## Build and deploy client
1. `cd context-clues/client`
2. `npm ci`
3. `npm run build`
4. Deploy `context-clues/client/dist` to the static path served by Caddy (`/`).

## Start/restart backend with PM2
1. `cd context-clues/server`
2. `npm ci`
3. `pm2 restart context-clues-server`
4. Verify with `curl http://127.0.0.1:3000/health`

## Enable embeddings (semantic mode)
1. Place source embeddings and vocab files in `context-clues/server/data`.
2. Build trimmed embeddings:
   - `cd context-clues/server`
   - `npm run build:embeddings`
3. Confirm `embeddings.trimmed.*` exists in `server/data`.
4. Restart PM2 and check health endpoint (`semanticEnabled: true`).

## Optional remote semantic fallback
- Default is disabled.
- Enable via env var before PM2 restart:
  - `ENABLE_REMOTE_SEMANTICS=true`
- This is only used for OOV fallback guesses and is rate-limited with in-memory LRU caching.

## Sanity scripts
- `cd context-clues/server`
- `npm run testRanker` prints one round target + sample ranks.
- `npm run resetStats` clears persistent stats (`server/data/stats.json`).
