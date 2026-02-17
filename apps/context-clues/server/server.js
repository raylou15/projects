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

app.post(["/token", "/api/token"], async (req, res) => {
  const gameForLog = cleanText(req.body?.game, 40) || "context-clues";
  console.info("[oauth] /token request", {
    game: gameForLog,
    hasCode: Boolean(req.body?.code),
    host: safeString(req.headers.host || "", 200),
    origin: safeString(req.headers.origin || "", 500),
    path: safeString(req.originalUrl || "", 500),
  });

  const code = cleanText(req.body?.code, 300);
  const oauthEnv = resolveDiscordOAuthEnv(req.body?.game);

  if (!oauthEnv.knownGame) {
    return res.status(400).send({
      error: "Unknown game",
      details: { expected: Object.keys(tokenEnvByGame), got: oauthEnv.game || cleanText(req.body?.game, 40) || "" },
    });
  }
  if (!code) return res.status(400).send({ error: "Missing code" });

  if (!oauthEnv.clientId || !oauthEnv.clientSecret) {
    return res.status(500).send({
      error: "Discord OAuth environment is not configured",
      details: {
        game: oauthEnv.game || "context-clues",
        expectedClientIdVars: oauthEnv.expectedClientIdVars,
        expectedClientSecretVars: oauthEnv.expectedClientSecretVars,
      },
    });
  }

  let response;
  let bodyText = "";
  let bodyJson = null;
  let contentType = "";

  try {
    response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthEnv.clientId,
        client_secret: oauthEnv.clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });

    contentType = response.headers.get("content-type") || "";
    bodyText = await response.text();

    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }
  } catch (err) {
    console.error("[oauth] token exchange request failed", {
      game: oauthEnv.game || "context-clues",
      message: err?.message || String(err),
    });
    return res.status(502).send({ error: "Discord token exchange request failed" });
  }

  if (!response.ok) {
    console.warn("[oauth] token exchange failed", {
      status: response.status,
      game: oauthEnv.game || "context-clues",
      contentType,
      bodyHead: safeString(bodyText, 800),
    });
    return res.status(response.status).send({
      error: "Discord token exchange failed",
      details: bodyJson || { raw: safeString(bodyText, 800), contentType },
    });
  }

  if (!bodyJson?.access_token) {
    console.warn("[oauth] token exchange returned no access_token", {
      status: response.status,
      game: oauthEnv.game || "context-clues",
      contentType,
      bodyHead: safeString(bodyText, 800),
    });
    return res.status(502).send({
      error: "Discord token exchange returned no access_token",
      details: bodyJson || { raw: safeString(bodyText, 800), contentType },
    });
  }

  console.info("[oauth] token exchange succeeded", { game: oauthEnv.game || "context-clues" });
  return res.send({ access_token: bodyJson.access_token });
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
