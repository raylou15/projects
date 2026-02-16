# Context Clues Runbook

## Backend source-of-truth + sync guardrail
- **Production runtime lives in `rays-games/server`** (deployed to `/root/rays-games/server` under pm2 process `rays-games`).
- `context-clues/server` is a staging/reference tree and must be intentionally kept in sync for gameplay/protocol behavior.
- CI runs `node scripts/check-server-sync.mjs` to compare critical files across both trees:
  - `server.js`
  - `game/*`
  - `similarity/*`
  - `stats/*`
- Temporary, explicit exceptions are stored in `.maintenance/server-sync-allowlist.json` and must include a reason.

### Allowed differences (must stay explicit)
- Allowlisted file-level divergence and context-only files are tracked in `.maintenance/server-sync-allowlist.json`.
- If you intentionally diverge a critical file, update that allowlist in the same PR and include a clear sunset plan.
- Unexpected divergence fails CI.

### Protocol-affecting change checklist (required)
If your change impacts WebSocket payloads, guess lifecycle, room isolation, ranking semantics, hints, stats schema, or API contracts:
1. Apply the change in **`rays-games/server`** first.
2. Mirror the equivalent change in **`context-clues/server`** (or add a justified temporary allowlist entry).
3. Run `node scripts/check-server-sync.mjs` and confirm no unexpected divergence.
4. Smoke-test with both trees bootable (`npm start` in each server folder).
5. Verify `/health` and `/api/health` compatibility and `ws` join/guess flow.
6. Document any intentional temporary divergence in PR notes with cleanup owner/date.

## Production paths (server)
- Backend runtime (pm2): `/root/rays-games`
- Frontend static root: `/var/www/rays-games`
- Caddy config: `/etc/caddy/Caddyfile`

## Backend setup + restart
1. `cd /root/rays-games/server`
2. `npm ci`
3. `pm2 restart rays-games`
4. `pm2 logs rays-games --lines 80`

## Vocab + embeddings rebuild (safe)
Run from backend server folder:

```bash
cd /root/rays-games/server
npm run rebuild:vocab -- --vocab-source data/sources/en_50k.txt --min-words 10000
# optional embeddings refresh (requires local GloVe file on server)
npm run rebuild:vocab -- --vocab-source data/sources/en_50k.txt --glove /root/models/glove.6B.100d.txt --min-words 10000
```

What it does:
- deterministically rebuilds `server/data/vocab-common.txt`
- optional `server/data/embeddings.trimmed.json` rebuild
- creates timestamped backups before overwrite
- aborts when vocab output is too small

## Frontend build/deploy
1. `cd /root/projects/context-clues/client`
2. `npm ci`
3. `npm run build`
4. Sync `dist/` to `/var/www/rays-games/`

## Verification checklist
```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS https://rays-games.loseyourip.com/api/health
wscat -c ws://127.0.0.1:3000/ws
wscat -c wss://rays-games.loseyourip.com/ws
curl -fsS "https://rays-games.loseyourip.com/api/normalize?word=hamburgers"
```

Expected normalization sample:
- `hamburgers` → canonical `hamburger`
- `armies` → canonical `army`
- `running`/`ran` → canonical `run`

## Local checks
```bash
cd /workspace/projects/rays-games/server
npm run test:normalize
npm run check:sync
npm start
```
