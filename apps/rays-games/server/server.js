import fs from "fs";
import http from "http";
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { RoomManager } from "./game/RoomManager.js";
import { StatsStore } from "./stats/StatsStore.js";
import { cleanText, validateMessage } from "./game/protocol.js";
import { SemanticRankService } from "./similarity/semantic.js";
import { loadGameModules } from "./gameModuleLoader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

const missingCriticalEnvVars = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"].filter(
  (key) => !process.env[key],
);
if (missingCriticalEnvVars.length > 0) {
  console.warn(
    `[startup] Missing critical env vars: ${missingCriticalEnvVars.join(", ")}. /token will fail until they are set.`,
  );
}

const app = express();
const port = Number(process.env.PORT || 3000);

const repoRoot = path.resolve(__dirname, "../../..");
const agentsPath = path.join(repoRoot, "AGENTS.md");

function extractHelpMarkdown() {
  try {
    const source = fs.readFileSync(agentsPath, "utf8");
    const marker = "## Help Content";
    const start = source.indexOf(marker);
    if (start === -1) return "";
    return source.slice(start + marker.length).trim();
  } catch {
    return "";
  }
}

const helpMarkdown = extractHelpMarkdown();

const similarityService = new SemanticRankService();
similarityService.load();
const statsStore = new StatsStore();

let isShuttingDown = false;

function flushStatsAndExit(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    statsStore.flushNow();
  } catch (error) {
    console.error("Failed to flush stats before shutdown", error);
  }
  if (signal) {
    process.exit(0);
  }
}

process.on("SIGINT", () => flushStatsAndExit("SIGINT"));
process.on("SIGTERM", () => flushStatsAndExit("SIGTERM"));
process.on("beforeExit", () => flushStatsAndExit());

const roomManager = new RoomManager(similarityService, statsStore);

app.use(express.json());

app.get(["/health", "/api/health"], (_req, res) => {
  res.send({ ok: true, semanticEnabled: similarityService.semanticEnabled });
});

app.get("/api/help", (_req, res) => {
  res.send({ markdown: helpMarkdown });
});

app.get("/api/debug/secret-selection", (_req, res) => {
  res.send(similarityService.getSecretSelectionDebug());
});

app.get("/api/normalize", (req, res) => {
  const input = cleanText(req.query?.word || "", 120);
  const normalized = similarityService.normalizeForGuess(input);
  const resolved = normalized.canonical ? similarityService.resolveAlias(normalized.canonical) : "";
  res.send({
    input,
    cleaned: normalized.display,
    canonical: normalized.canonical,
    resolved,
    valid: normalized.valid,
    reason: normalized.reason,
  });
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
const customUpgradeHandlers = [];

function registerUpgradeHandler(handler) {
  if (typeof handler === "function") customUpgradeHandlers.push(handler);
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
    return;
  }

  for (const handler of customUpgradeHandlers) {
    try {
      if (handler(request, socket, head) === true) return;
    } catch (error) {
      console.warn("[upgrade] custom handler failed", error);
    }
  }

  socket.destroy();
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
      const roomKey = cleanText(msg.roomKey, 160);
      const guildId = cleanText(msg.guildId, 80);
      const channelId = cleanText(msg.channelId, 80);
      const instanceId = cleanText(msg.instanceId, 128);
      const derivedRoomKey = roomKey || (guildId && channelId ? `${guildId}:${channelId}` : instanceId);

      if (!derivedRoomKey) {
        ws.send(JSON.stringify({ t: "error", v: 1, message: "roomKey or instanceId required" }));
        return;
      }

      room = roomManager.getOrCreate(derivedRoomKey);
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

await loadGameModules({ app, server, wss, logger: console, registerUpgradeHandler });

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
