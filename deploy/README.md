# Deploy Notes (Server)

- Caddyfile lives in /etc/caddy/Caddyfile (copy stored here)
- Backend is Node/Express/WS on 127.0.0.1:3000 managed by PM2
- Frontend is Vite build output copied to /var/www/rays-games

## Build + deploy frontend
cd /root/projects/context-clues-repo/client
npm ci
npm run build
sudo rsync -av --delete dist/ /var/www/rays-games/

## Run backend
cd /root/projects/context-clues-repo/server
npm ci
pm2 start server.js --name context-clues
pm2 save

## Env (server only)
Create /root/projects/context-clues-repo/server/.env with:
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
