# Trivia Game (Rays Games)

## Local development

### Backend
From `apps/rays-games/server`:

```bash
npm install
DATABASE_URL='mongodb://localhost:27017/rays-games' npm start
```

### Frontend
From `apps/trivia/client`:

```bash
npm install
npm run dev
```

## Required environment variables

- `DATABASE_URL` (preferred MongoDB URI)
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `VITE_DISCORD_CLIENT_ID` (frontend build)

Backend fallback supports `process.env.DATABASE_URL || config.DatabaseURL`.

## Usage modes

- **Discord Activity mode**: open under `/g/trivia` with `frame_id` in URL.
- **Browser mode**: open `/g/trivia`, create or join `public:<code>` room.

## WebSocket + API

- WS: `/ws/trivia`
- Health: `GET /api/trivia/health`
- Leaderboard: `GET /api/trivia/leaderboard?scope=global|season|room&roomKey=<key>`
- Me: `GET /api/trivia/me?userId=<id>&roomKey=<key>`
