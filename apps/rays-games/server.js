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

const tokenEnvByGame = {
  "context-clues": {
    clientId: ["CONTEXT_CLUES_DISCORD_CLIENT_ID", "DISCORD_CLIENT_ID"],
    clientSecret: ["CONTEXT_CLUES_DISCORD_CLIENT_SECRET", "DISCORD_CLIENT_SECRET"],
  },
  trivia: {
    clientId: ["TRIVIA_DISCORD_CLIENT_ID", "DISCORD_CLIENT_ID"],
    clientSecret: ["TRIVIA_DISCORD_CLIENT_SECRET", "DISCORD_CLIENT_SECRET"],
  },
};

function firstEnvValue(keys = []) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return "";
}

function resolveDiscordOAuthEnv(gameRaw) {
  const game = cleanText(gameRaw, 40).toLowerCase();
  const envMap = tokenEnvByGame[game];
  if (!envMap) {
    return {
      game,
      knownGame: false,
      clientId: "",
      clientSecret: "",
      expectedClientIdVars: [],
      expectedClientSecretVars: [],
    };
  }
  return {
    game,
    knownGame: true,
    clientId: firstEnvValue(envMap.clientId),
    clientSecret: firstEnvValue(envMap.clientSecret),
    expectedClientIdVars: envMap.clientId,
    expectedClientSecretVars: envMap.clientSecret,
  };
}

for (const [game, envMap] of Object.entries(tokenEnvByGame)) {
  const clientId = firstEnvValue(envMap.clientId);
  const clientSecret = firstEnvValue(envMap.clientSecret);
  if (!clientId || !clientSecret) {
    console.warn(
      `[startup] Missing Discord OAuth env for ${game}. Set one of ${envMap.clientId.join(" | ")} and one of ${envMap.clientSecret.join(" | ")} for /token.`,
    );
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);

console.info("[startup] Rays Games server boot", {
  nodeEnv: process.env.NODE_ENV || "development",
  port,
  envPath,
  cwd: process.cwd(),
  hasContextCluesClientId: Boolean(process.env.CONTEXT_CLUES_DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID),
  hasContextCluesClientSecret: Boolean(process.env.CONTEXT_CLUES_DISCORD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET),
  hasTriviaClientId: Boolean(process.env.TRIVIA_DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID),
  hasTriviaClientSecret: Boolean(process.env.TRIVIA_DISCORD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET),
});

const repoRoot = path.resolve(__dirname, "../../..");
const agentsPath = path.join(repoRoot, "AGENTS.md");

// ======================================================
// Static client hosting (optional but recommended)
// ======================================================
// If your reverse proxy (nginx/caddy) is already serving the Vite dist/ folders,
// this block is harmless. If it is NOT, this prevents the common “white screen”
// failure mode where the server accidentally serves raw Vite source files.

function staticErrorPage(slug, distDir) {
  const mountPath = `/${slug}/`;
  return `<!doctype html>
  <html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${slug} - build missing</title>
    <style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;line-height:1.4}code,pre{background:#f6f8fa;padding:.15rem .35rem;border-radius:6px}pre{padding:12px;overflow:auto}</style>
  </head><body>
    <h1>${slug}: client build not found</h1>
    <p>I looked for <code>${distDir}/index.html</code> but it does not exist.</p>
    <p>This usually causes a blank white screen when the browser is served <em>source</em> files (bare module imports).</p>
    <h3>Fix</h3>
    <pre>cd apps/${slug}/client
npm ci
npm run build

# then (if you serve static outside node)
rsync -a --delete dist/ /var/www/rays-games/${slug}/</pre>
    <p>Expected URL: <code>${mountPath}</code></p>
  </body></html>`;
}

function mountViteDist(slug) {
  const distDir = path.join(repoRoot, "apps", slug, "client", "dist");
  const indexPath = path.join(distDir, "index.html");
  const mountPath = `/${slug}`;

  // Always register routes so you get a useful error page instead of a blank frame.
  if (!fs.existsSync(indexPath)) {
    app.get([mountPath, `${mountPath}/`, `${mountPath}/*`], (_req, res) => {
      res.status(503).type("html").send(staticErrorPage(slug, distDir));
    });
    console.warn(`[static] ${slug}: missing dist at ${distDir} (index.html not found)`);
    return false;
  }

  app.use(mountPath, express.static(distDir, { index: false }));
  app.get([mountPath, `${mountPath}/`, `${mountPath}/*`], (_req, res) => res.sendFile(indexPath));
  console.info(`[static] mounted ${slug} at ${mountPath}/ from ${distDir}`);
  return true;
}

function autoMountClients() {
  const appsDir = path.join(repoRoot, "apps");
  if (!fs.existsSync(appsDir)) return [];
  const slugs = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name && name !== "rays-games" && !name.startsWith("."));

  const mounted = [];
  for (const slug of slugs) {
    const ok = mountViteDist(slug);
    if (ok) mounted.push(slug);
  }

  // Tiny landing page so "/" isn't just confusing/blank.
  if (mounted.length) {
    app.get("/", (_req, res) => {
      const links = mounted.map((slug) => `<li><a href="/${slug}/">/${slug}/</a></li>`).join("");
      res
        .type("html")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Rays Games</title></head><body style="font-family:system-ui,sans-serif;padding:24px"><h1>Rays Games</h1><p>Available activities:</p><ul>${links}</ul></body></html>`,
        );
    });
  }

  return mounted;
}

autoMountClients();

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

process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection", reason);
});

const roomManager = new RoomManager(similarityService, statsStore);

app.use(express.json());

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path === "/health" || req.path === "/api/health") return;
    console.info("[http]", { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - started });
  });
  next();
});

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
  console.info("[oauth] /token request", { game: cleanText(req.body?.game, 40) || "context-clues", hasCode: Boolean(req.body?.code) });
  const code = cleanText(req.body?.code, 300);
  const oauthEnv = resolveDiscordOAuthEnv(req.body?.game);
  if (!oauthEnv.knownGame) {
    return res.status(400).send({
      error: "Unknown game",
      details: { expected: Object.keys(tokenEnvByGame), got: oauthEnv.game || cleanText(req.body?.game, 40) || "" },
    });
  }
  if (!code) {
    return res.status(400).send({ error: "Missing code" });
  }
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

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthEnv.clientId,
      client_secret: oauthEnv.clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    console.warn("[oauth] token exchange failed", { status: response.status, game: oauthEnv.game || "context-clues", details: json });
    return res.status(response.status).send({ error: "Discord token exchange failed", details: json });
  }

  console.info("[oauth] token exchange succeeded", { game: oauthEnv.game || "context-clues" });
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
  console.info("[ws] upgrade", { path: url.pathname, host: request.headers.host || "", origin: request.headers.origin || "" });
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
  console.info("[ws] connected", { clients: wss.clients.size });

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
      console.info("[ws] join request", { roomKey: cleanText(msg.roomKey, 160), guildId: cleanText(msg.guildId, 80), channelId: cleanText(msg.channelId, 80), instanceId: cleanText(msg.instanceId, 128) });
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
      console.info("[ws] joined room", { roomKey: derivedRoomKey });
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
    console.info("[ws] disconnected", { roomKey: room?.id || null, clients: wss.clients.size });
    if (room) room.removeSocket(ws);
  });

  ws.on("error", (error) => {
    console.warn("[ws] socket error", { message: error?.message || String(error) });
  });
});

await loadGameModules({ app, server, wss, logger: console, registerUpgradeHandler });

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
