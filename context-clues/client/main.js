import './style.css'
import rocketLogo from '/rocket.png'
import { DiscordSDK } from "@discord/embedded-app-sdk";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

function ui(status, debugObj) {
  const appEl = document.querySelector('#app');
  appEl.innerHTML = `
    <div>
      <img src="${rocketLogo}" class="logo" alt="Discord" />
      <h1>Context Clues</h1>
      <p id="status">${status}</p>
      <pre id="debug" style="text-align:left; white-space:pre-wrap; word-break:break-word;"></pre>

      <div id="wsBox" style="margin-top:16px; text-align:left;">
        <h3 style="margin:12px 0 6px;">Multiplayer</h3>
        <p id="wsStatus">WS: (not connected)</p>
        <div id="wsLog" style="border:1px solid rgba(255,255,255,0.15); border-radius:10px; padding:10px; max-height:220px; overflow:auto;"></div>

        <form id="chatForm" style="margin-top:10px; display:flex; gap:8px;">
          <input id="chatInput" type="text" placeholder="Type a message…" autocomplete="off"
                 style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:rgba(0,0,0,0.15); color:inherit;">
          <button id="chatSend" type="submit"
                  style="padding:10px 14px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.08); color:inherit; cursor:pointer;">
            Send
          </button>
        </form>
      </div>
    </div>
  `;

  if (debugObj !== undefined) {
    document.querySelector('#debug').textContent =
      typeof debugObj === "string" ? debugObj : JSON.stringify(debugObj, null, 2);
  }
}

function setWsStatus(text) {
  const el = document.querySelector('#wsStatus');
  if (el) el.textContent = `WS: ${text}`;
}

function addWsLine(text) {
  const log = document.querySelector('#wsLog');
  if (!log) return;
  const p = document.createElement('p');
  p.style.margin = '6px 0';
  p.textContent = text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response (${resp.status}): ${text.slice(0, 200)}`); }
}

function wsUrl() {
  // Discord Activity runs in an iframe/proxy context; location.host should still be your mapped host.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

async function boot() {
  ui("Starting…");

  try {
    await sdk.ready();
    ui("✅ Discord SDK ready", { instanceId: sdk.instanceId });

    // Authorize (RPC OAuth flow): DO NOT pass redirect_uri here.
    let code;
    try {
      ({ code } = await sdk.commands.authorize({
        client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
        response_type: "code",
        prompt: "none",
        scope: ["identify"],
      }));
    } catch {
      // If silent auth fails, retry with consent prompt
      ({ code } = await sdk.commands.authorize({
        client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
        response_type: "code",
        prompt: "consent",
        scope: ["identify"],
      }));
    }

    // Exchange code on your backend: POST /api/token -> backend /token
    const tokenResp = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const tokenJson = await safeJson(tokenResp);
    if (!tokenJson?.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    // Authenticate with Discord (gives you a session in the embedded context)
    const auth = await sdk.commands.authenticate({ access_token: tokenJson.access_token });
    if (!auth) throw new Error("authenticate() returned null");

    // Fetch current user
    const meResp = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const me = await meResp.json();

    ui(`✅ Logged in as ${me.username}${me.discriminator ? "#" + me.discriminator : ""}`, {
      instanceId: sdk.instanceId,
      channelId: sdk.channelId,
      guildId: sdk.guildId,
      user: { id: me.id, username: me.username, discriminator: me.discriminator },
    });

    // ---- WebSocket multiplayer ----
    setWsStatus("connecting…");
    addWsLine(`Connecting to ${wsUrl()} …`);

    const ws = new WebSocket(wsUrl());
    let joined = false;

    ws.addEventListener("open", () => {
      setWsStatus("connected");
      addWsLine("🟢 Connected.");

      // Join room by instanceId
      ws.send(JSON.stringify({
        t: "join",
        instanceId: sdk.instanceId,
        user: { id: me.id, username: me.username }
      }));
    });

    ws.addEventListener("close", () => {
      setWsStatus("disconnected");
      addWsLine("🔴 Disconnected.");
    });

    ws.addEventListener("error", () => {
      setWsStatus("error");
      addWsLine("⚠️ WebSocket error (check server logs).");
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === "welcome") {
        joined = true;
        addWsLine(`✅ Joined room: ${msg.instanceId}`);
        if (msg.peers?.length) addWsLine(`Peers: ${msg.peers.map(p => p.username).join(", ")}`);
        else addWsLine("Peers: (none yet)");
        return;
      }
      if (msg.t === "joined") return addWsLine(`➕ ${msg.user.username} joined`);
      if (msg.t === "left") return addWsLine(`➖ ${msg.user.username} left`);
      if (msg.t === "chat") return addWsLine(`💬 ${msg.user.username}: ${msg.text}`);
      if (msg.t === "error") return addWsLine(`⚠️ ${msg.error}`);
    });

    // Chat input wiring
    const form = document.querySelector("#chatForm");
    const input = document.querySelector("#chatInput");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = (input.value || "").trim();
      if (!text) return;

      if (ws.readyState !== WebSocket.OPEN) {
        addWsLine("⚠️ Can't send: WS not open.");
        return;
      }
      if (!joined) {
        addWsLine("⚠️ Can't send: not joined yet.");
        return;
      }

      ws.send(JSON.stringify({ t: "chat", text }));
      input.value = "";
      input.focus();
    });

  } catch (e) {
    console.error(e);
    ui("⚠️ SDK/auth failed (see debug + console)", String(e?.message || e));
    setWsStatus("disabled");
  }
}

boot();
