# AGENTS.md — Context Clues (Discord Activity)

This repo powers **Context Clues**, a Discord Activity inspired by Contexto:
- **Frontend**: Vite + vanilla JS (white, responsive UI)
- **Backend**: Node + Express + WebSocket (ws)
- **Reverse proxy / TLS**: Caddy (serves SPA + proxies `/api/*` + `/ws`)
- **Runtime**: pm2 on the server

The goal is: **open the Activity → immediately playable**, solo or multiplayer, with real-time shared guesses.

---

## 0) Canonical “truth” vs “deployment” (IMPORTANT)

### Repo (GitHub / your PC)
This is where changes should be made and committed.

### Server (production host)
The server runs production copies of:
- **Backend runtime**: `/root/rays-games/` (pm2-managed)
- **Frontend web root**: `/var/www/rays-games/`
- **Caddy config**: `/etc/caddy/Caddyfile`
- **Helper scripts**: `/usr/local/bin/`

**Do not “develop” by editing random files on the server** unless you’re fixing an emergency. Prefer: commit → deploy.

---

## 1) Directory mapping (deploy targets)

When deploying from the repo on the server, copy:
- `repo/deploy/caddy/` → `/etc/caddy/`
- `repo/deploy/cmds/`  → `/usr/local/bin/`
- `repo/context-clues/` → `/root/projects/context-clues/`  *(optional staging/source on server)*
- `repo/rays-games/`   → `/root/rays-games/`              *(production backend runtime)*

Frontend build output always ends up in:
- `client/dist/` → `/var/www/rays-games/`

---

## 2) Required environment variables (server)

### Production backend env file
Store secrets on the server (NOT in git) at:
- `/root/rays-games/.env`

Expected keys:
- `DISCORD_CLIENT_ID=...`
- `DISCORD_CLIENT_SECRET=...`
- `PORT=3000`  *(recommended for production)*

Frontend build env (Vite) expects:
- `VITE_DISCORD_CLIENT_ID=...`

**Never commit real secrets.**
If you need examples, use `.env.example` in the repo.

---

## 3) Networking / routing contract (Caddy)

The public domain:
- `https://rays-games.loseyourip.com`

Routing requirements:
- `/` and everything else serves the SPA from `/var/www/rays-games`
- `/api/*` proxies to backend on `127.0.0.1:3000` (prefix stripped)
- `/ws` (or `/ws*`) proxies as WebSocket to backend

If WebSockets fail publicly but work on `ws://127.0.0.1:3000/ws`, the Caddy routing is the first suspect.

---

## 4) Backend responsibilities

Backend must provide:
- `GET /health` (and/or `/api/health`) → `{ ok: true, semanticEnabled: boolean }`
- `POST /token` (and/or `/api/token`) → exchanges Discord auth code for `access_token`
- WebSocket endpoint at `/ws`:
  - Accepts `join` then `guess`
  - Broadcasts `snapshot`, `guess_result`, `round_won`, `new_round`, etc.

### Room isolation (“multiple servers”)
Rooms should NOT be global.
Room key should be derived from Discord context so each Activity launch in each channel is isolated.

Recommended room key:
- `roomKey = sdk.channelId` (or `${sdk.guildId}:${sdk.channelId}`)

`instanceId` is okay for per-launch isolation, but **channel-based** is preferred for “this channel has its own game”.

---

## 5) WebSocket protocol (v=1)

Client → Server:
- `{ v:1, t:"join", instanceId|roomKey, user:{ id, username, avatarUrl } }`
- `{ v:1, t:"guess", word:"..." }`

Server → Client:
- `{ v:1, t:"snapshot", state:{ ... } }`
- `{ v:1, t:"guess_result", entry:{ ... }, totals:{ totalGuesses, yourGuesses } }`
- `{ v:1, t:"round_won", winner, word, nextRoundInMs }`
- `{ v:1, t:"new_round", roundId }`
- `{ v:1, t:"error", message:"..." }`

Compatibility rule:
- Any change must be **backwards-safe** or version-bumped.

---

## 6) Semantic ranking / “Contexto-like” proximity

The repo may support:
- A small local vocab (fallback)
- Optional GloVe embeddings (semantic mode)

### Reality check
If `vocab-common.txt` is tiny (e.g., 182 words), guesses will look “broken” because nearly everything ranks the same or “approx”.
**A real game needs a large vocab + embeddings (or a strong alternative approach).**

### Large files policy
Do NOT commit:
- raw `glove.6B.*d.txt`
- giant zips
- huge derived artifacts unless intentionally curated

Prefer:
- keep raw GloVe files on the server only
- generate a trimmed embedding file on the server
- store trimmed outputs only if reasonably sized and you explicitly want it in git

---

## 7) Frontend responsibilities

Frontend must:
- Render a **white** Contexto-like UI
- Work on **all resolutions** (mobile/desktop/tablet)
- Join automatically (no lobby)
- Show:
  - total guesses (shared)
  - your guesses (per-player)
  - guess rows with avatar (left), word, rank (right), colored band + closeness bar
- Provide a **Help** button explaining rules
- Handle reconnects cleanly

---

## 8) Player stats / scoring

Stats goals:
- Per-player persistent profile stats (wins, best rank, avg rank, total guesses, streaks, etc.)
- Per-round stats (who won, in how many guesses)
- Storage options:
  - simplest: JSON file / local DB on server
  - better: SQLite (still self-hosted)
  - best: Mongo/Postgres if you already run it

Hard rule:
- Stats logic must be keyed per “room” (channel) and per “user”.

---

## 9) How to run locally (PC)

### Frontend (PC)
From repo frontend folder:
- `npm install`
- `npm run dev` (local)
- `npm run build` (production dist)

### Backend (PC)
From backend folder:
- `npm install`
- `npm run start` (or `node server.js`)

Local testing typically won’t fully auth with Discord unless you’re running inside Discord.
Use the “browser fallback identity” for UI smoke tests.

---

## 10) How to run in production (SERVER)

### Services
- Caddy runs systemd service: `sudo systemctl status caddy`
- Backend runs pm2: `pm2 list`

pm2 process name is expected to be:
- `rays-games`

### Key paths
- backend runtime: `/root/rays-games/`
- backend entry: whatever pm2 is configured to run (verify with `pm2 describe rays-games`)
- web root: `/var/www/rays-games/`
- caddy config: `/etc/caddy/Caddyfile`

---

## 11) “Deploy sanity checks” (SERVER)

After deploying:
1) Backend local:
- `curl -fsS http://127.0.0.1:3000/health`

2) Backend public:
- `curl -fsS https://rays-games.loseyourip.com/api/health`

3) WebSockets local:
- `wscat -c ws://127.0.0.1:3000/ws`

4) WebSockets public:
- `wscat -c wss://rays-games.loseyourip.com/ws`

5) Homepage:
- `curl -I https://rays-games.loseyourip.com/ | head`

If `/api/health` works but `/ws` fails publicly → Caddy WS routing issue.
If both fail → backend down / pm2 down / wrong port.

---

## 12) Common failure modes (fast triage)

### 502 from Caddy
- backend not running
- wrong port in proxy
- pm2 crashed
Check:
- `pm2 logs rays-games --lines 80`
- `curl http://127.0.0.1:3000/health`

### 404 for `/`
- `/var/www/rays-games/` empty or wrong
Fix:
- rebuild frontend
- rsync `dist/` to `/var/www/rays-games/`

### wscat to public `/ws` returns 404
- Caddyfile WS block not matching path/headers
Fix:
- ensure `handle /ws* { reverse_proxy 127.0.0.1:3000 }`
- reload caddy

### Every guess ranks the same
- vocab is tiny OR semantic mode disabled
Fix:
- expand vocab and/or enable embeddings / better ranker

---

## 13) Rules for AI agents (Codex) working on this repo

When you change anything:
- Update both client + server if protocol or routing changes
- Keep UI mobile-first and white-themed
- Keep the game playable with **1 player** and with many
- Never hardcode secrets
- Provide a short “how to test” checklist in the PR summary

Definition of done:
- Frontend builds clean (`npm run build`)
- Backend boots clean
- `/api/health` works
- WebSockets work locally and through Caddy
- Game runs without a lobby and is playable immediately
- Ranking works (not all guesses collapsing to the same rank)
- UI behaves correctly on narrow and wide screens

---

## Help Content

### Goal
- Guess the secret word as quickly as possible.
- Lower rank numbers are better: `1` is the exact hidden word.

### How to play
- Type one word at a time and press Enter.
- Each guess gets a rank. Smaller rank = semantically closer.
- Keep refining guesses toward lower ranks until someone hits rank `1`.

### Hints
- Use the **Hint** button to request a clue word that is closer to the target.
- Hints are rate-limited and not always available.

### Multiplayer rooms
- Activity sessions are scoped to the Discord channel context.
- Everyone in the same channel sees shared guesses and progress.

### UI controls
- **Help** opens this guide.
- **Hint** asks the server for a nearby clue word.
- **Players** shows connected players in your room.
- **Sound** toggles audio (SFX/music) if enabled.

### Notes for maintainers
- Keep this section updated whenever gameplay rules or controls change.
- The in-game Help modal reads this section from `AGENTS.md` via `/api/help`.

---

## Production backend source of truth (anti-regression)

- **Production backend code lives in `rays-games/server`** and this is what maps to `/root/rays-games/` under pm2 process `rays-games`.
- `context-clues/server` is a staging/reference copy and must not be treated as production runtime.
- Any gameplay, protocol, hint, vocabulary, or duplicate-guess fixes must be implemented in `rays-games/server` to affect live behavior.

## Quick how-to-test checklist

- Guess `hamburgers` then `hamburger` in the same room: second guess should be rejected as already guessed.
- Guess a 3-letter word like `cow`: it should be accepted when it exists in vocab.
- Trigger Hint: a new rankings row should appear with user `?` (hint row) and a rank number.
- Guess non-English common stopwords like `que`, `und`, `les`: they should be rejected.

---

## Legal pages (static)

- Legal pages are static files in `context-clues/client/public/{terms,privacy}/index.html`.
- Public URLs are `https://rays-games.loseyourip.com/terms/` and `https://rays-games.loseyourip.com/privacy/`.
- For Discord Developer Portal legal fields, use the full URLs above.
