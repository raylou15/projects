import express from "express";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/token", async (req, res) => {
  try {
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: "missing_code" });

    const client_id = process.env.DISCORD_CLIENT_ID;
    const client_secret = process.env.DISCORD_CLIENT_SECRET;

    if (!client_id || !client_secret) {
      return res.status(500).json({
        error: "missing_env",
        need: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
      });
    }

    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        client_secret,
        grant_type: "authorization_code",
        code,
      }),
    });

    const tokenJson = await tokenResp.json().catch(() => ({}));

    if (!tokenResp.ok || !tokenJson?.access_token) {
      return res.status(400).json({
        error: "token_exchange_failed",
        details: tokenJson,
      });
    }

    return res.json({ access_token: tokenJson.access_token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "token_exchange_exception" });
  }
});

// ---- WebSocket multiplayer ----
// Rooms keyed by instanceId -> Set of sockets
const rooms = new Map(); // instanceId -> Set(ws)

// Utility: safe JSON send
function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(instanceId, obj) {
  const set = rooms.get(instanceId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.instanceId = null;
  ws.user = null;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return wsSend(ws, { t: "error", error: "invalid_json" });
    }

    // First message must be a join:
    // { t: "join", instanceId: "...", user: { id, username } }
    if (msg?.t === "join") {
      const instanceId = msg?.instanceId;
      const user = msg?.user;

      if (!instanceId || typeof instanceId !== "string") {
        return wsSend(ws, { t: "error", error: "missing_instanceId" });
      }
      if (!user?.id) {
        return wsSend(ws, { t: "error", error: "missing_user" });
      }

      // If already joined a room, ignore
      if (ws.instanceId) return;

      ws.instanceId = instanceId;
      ws.user = { id: String(user.id), username: String(user.username || "Unknown") };

      if (!rooms.has(instanceId)) rooms.set(instanceId, new Set());
      rooms.get(instanceId).add(ws);

      // Tell the new user who else is in the room
      const peers = Array.from(rooms.get(instanceId))
        .filter(s => s !== ws && s.user)
        .map(s => s.user);

      wsSend(ws, { t: "welcome", instanceId, you: ws.user, peers });

      // Tell everyone else someone joined
      broadcast(instanceId, { t: "joined", user: ws.user });

      return;
    }

    // After join, allow chat messages
    if (msg?.t === "chat") {
      if (!ws.instanceId || !ws.user) return wsSend(ws, { t: "error", error: "not_joined" });
      const text = String(msg?.text || "").slice(0, 500);
      if (!text) return;
      broadcast(ws.instanceId, { t: "chat", user: ws.user, text, ts: Date.now() });
      return;
    }

    wsSend(ws, { t: "error", error: "unknown_message_type" });
  });

  ws.on("close", () => {
    if (!ws.instanceId) return;
    const set = rooms.get(ws.instanceId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(ws.instanceId);
    }
    if (ws.user) broadcast(ws.instanceId, { t: "left", user: ws.user });
  });

  ws.on("error", () => {});
});

// Keep connections alive (basic heartbeat)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(3000, "127.0.0.1", () => {
  console.log("backend (http + ws) listening on 127.0.0.1:3000");
});
