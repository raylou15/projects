import http from "http";
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { RoomManager } from "./game/RoomManager.js";
import { cleanText, validateMessage } from "./game/protocol.js";

dotenv.config({ path: "../.env" });

const app = express();
const port = Number(process.env.PORT || 3001);
const roomManager = new RoomManager();

app.use(express.json());

app.get(["/health", "/api/health"], (_req, res) => {
  res.send({ ok: true });
});

app.post(["/token", "/api/token"], async (req, res) => {
  const code = cleanText(req.body?.code, 300);
  if (!code) {
    return res.status(400).send({ error: "Missing code" });
  }

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });

  const json = await response.json();

  if (!response.ok) {
    return res.status(response.status).send({ error: "Discord token exchange failed", details: json });
  }

  return res.send({ access_token: json.access_token });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  let room = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ t: "error", error: "Invalid JSON." }));
      return;
    }

    const parsed = validateMessage(msg);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: "error", error: parsed.error }));
      return;
    }

    if (msg.t === "join") {
      const instanceId = cleanText(msg.instanceId, 128);
      if (!instanceId) {
        ws.send(JSON.stringify({ t: "error", error: "instanceId required" }));
        return;
      }

      room = roomManager.getOrCreate(instanceId);
      room.addSocket(ws);
      room.handleJoin(ws, msg);
      return;
    }

    if (!room) {
      ws.send(JSON.stringify({ t: "error", error: "Join first." }));
      return;
    }

    room.handleClientMessage(ws, msg);
  });

  ws.on("close", () => {
    if (room) {
      room.removeSocket(ws);
    }
  });
});

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
