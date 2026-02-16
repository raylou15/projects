# Context Clues Runbook

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
npm start
```
