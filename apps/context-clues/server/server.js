import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { RoomManager } from "./game/RoomManager.js";
import { cleanText, validateMessage } from "./game/protocol.js";
import { SemanticRankService } from "./similarity/semantic.js";
import { StatsStore } from "./stats/StatsStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

const missingCriticalEnvVars = ["CONTEXT_CLUES_DISCORD_CLIENT_ID", "CONTEXT_CLUES_DISCORD_CLIENT_SECRET"].filter(
  (key) => !process.env[key],
);
if (missingCriticalEnvVars.length > 0) {
  console.warn(
    `[startup] Missing critical env vars: ${missingCriticalEnvVars.join(", ")}. /token will fail until they are set.`,
  );
}

const repoRoot = path.resolve(__dirname, "../../..");

const app = express();
const port = Number(process.env.PORT || 3000);

const similarityService = new SemanticRankService();
similarityService.load();
const statsStore = new StatsStore();
const roomManager = new RoomManager(similarityService, statsStore);

app.use(express.json());

// =========================
// Client -> PM2 log relay
// =========================
const CLIENT_LOG_MAX_PER_MIN = Number(process.env.CLIENT_LOG_MAX_PER_MIN || 200);
const _clientLogBuckets = new Map(); // ip -> { start, count }

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function allowClientLog(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = _clientLogBuckets.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  _clientLogBuckets.set(ip, bucket);
  return bucket.count <= CLIENT_LOG_MAX_PER_MIN;
}

function safeStr(v, max = 2000) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s || "").slice(0, max);
}

app.post("/api/client-log", (req, res) => {
  const ip = getClientIp(req);
  if (!allowClientLog(ip)) return res.status(204).end();

  const entries = Array.isArray(req.body) ? req.body : [req.body];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const game = safeStr(e.game || "unknown", 50);
    const level = safeStr(e.level || "info", 10).toLowerCase();
    const msg = safeStr(e.message || "", 2000);
    const meta = e.meta && typeof e.meta === "object" ? e.meta : undefined;

    const prefix = `[client:${game}]`;
    if (level === "error") console.error(prefix, msg, meta || "");
    else if (level === "warn" || level === "warning") console.warn(prefix, msg, meta || "");
    else console.info(prefix, msg, meta || "");
  }

  res.status(204).end();
});

function getHelpMarkdown() {
  const agentsPath = path.resolve(repoRoot, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) return "# Help\nHelp content is not available right now.";

  const markdown = fs.readFileSync(agentsPath, "utf8");
  const marker = "## Help Content";
  const start = markdown.indexOf(marker);
  if (start === -1) return markdown;

  const rest = markdown.slice(start + marker.length);
  const nextHeading = rest.search(/\n##\s+/);
  if (nextHeading === -1) return `${marker}${rest}`.trim();
  return `${marker}${rest.slice(0, nextHeading)}`.trim();
}

app.get(["/health", "/api/health"], (_req, res) => {
  res.send({ ok: true, semanticEnabled: similarityService.semanticEnabled });
});

app.get(["/help", "/api/help"], (_req, res) => {
  res.send({ markdown: getHelpMarkdown() });
});

app.post(["/token", "/api/token"], async (req, res) => {
  const code = cleanText(req.body?.code, 300);
  if (!code) return res.status(400).send({ error: "Missing code" });

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.CONTEXT_CLUES_DISCORD_CLIENT_ID || process.env.CONTEXT_CLUES_DISCORD_CLIENT_ID,
      client_secret: process.env.CONTEXT_CLUES_DISCORD_CLIENT_SECRET,
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

  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  let room = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ t: "error", v: 1, message: "Invalid JSON" }));
      return;
    }

    const parsed = validateMessage(msg);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: "error", v: 1, message: parsed.error }));
      return;
    }

    if (msg.t === "join") {
      const guildId = cleanText(msg.guildId, 64);
      const channelId = cleanText(msg.channelId, 64);
      const roomKey = cleanText(msg.roomKey, 140);
      const instanceId = cleanText(msg.instanceId, 120);

      let roomId = "";
      if (guildId && channelId) roomId = `${guildId}:${channelId}`;
      else if (roomKey) roomId = roomKey;
      else if (channelId) roomId = channelId;
      else if (instanceId) roomId = `instance:${instanceId}`;

      if (!roomId) {
        ws.send(JSON.stringify({ t: "error", v: 1, message: "guildId+channelId, roomKey, or instanceId required" }));
        return;
      }

      room = roomManager.getOrCreate(roomId);
      room.addSocket(ws);
      room.handleJoin(ws, msg);
      return;
    }

    if (!room) {
      ws.send(JSON.stringify({ t: "error", v: 1, message: "Join first" }));
      return;
    }

    room.handleClientMessage(ws, msg);
  });

  ws.on("close", () => {
    if (room) room.removeSocket(ws);
  });
});

server.listen(port, () => {
  console.log(`Server listening at http://127.0.0.1:${port}`);
});
