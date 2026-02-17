import "./style.css";
import confetti from "canvas-confetti";
import { DiscordSDK } from "@discord/embedded-app-sdk";

const app = document.querySelector("#app");
const q = new URLSearchParams(location.search);
const hasFrameId = Boolean(q.get("frame_id"));
const API_BASE = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");
const WS_URL = (import.meta.env.VITE_WS_URL || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/trivia`).trim();

const state = {
  mode: hasFrameId ? "activity" : "browser",
  roomKey: null,
  user: null,
  ws: null,
  wsState: "idle",
  seq: 0,
  phase: "lobby",
  players: [],
  questionPublic: null,
  timer: null,
  resultsPublic: null,
  skipVotes: { votes: [], threshold: 1 },
  hintPublic: { autoHintActive: false, autoHintText: null },
  hiddenAnswers: [],
  personalHintUsed: false,
  roomCodeInput: "",
};

function render() {
  if (!state.roomKey || !state.user) {
    app.innerHTML = joinView();
    bindJoin();
    return;
  }

  const now = Date.now();
  const deadline = state.timer?.deadlineAt || now;
  const total = state.phase === "question" ? 25_000 : 8_000;
  const remain = Math.max(0, deadline - now);
  const pct = Math.max(0, Math.min(100, (remain / total) * 100));

  app.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <strong>Trivia</strong>
        <span class="badge">${state.wsState}</span>
      </div>
      <div class="meta"><span>Room: <b>${state.roomKey}</b></span><span>Phase: <b>${state.phase}</b></span></div>
      <div class="timer"><div style="width:${pct}%"></div></div>
    </div>

    <div class="card">
      <h3>Players</h3>
      ${state.players
        .map(
          (p) => `<div class="player"><span>${escapeHtml(p.displayName)} ${p.connected ? "🟢" : "⚪"}</span><span>${p.points} pts · streak ${p.currentStreak}</span></div>`,
        )
        .join("")}
    </div>

    ${state.phase === "question" && state.questionPublic ? questionView() : ""}
    ${state.phase === "results" && state.resultsPublic ? resultsView() : ""}
    ${state.phase === "lobby" ? `<div class="card"><p>Waiting for players… round auto-starts with at least 1 connected player.</p></div>` : ""}
  `;

  bindActions();
}

function questionView() {
  const qp = state.questionPublic;
  const skipCount = state.skipVotes?.votes?.length || 0;
  const hidden = new Set(state.hiddenAnswers);
  return `
    <div class="card">
      <div class="meta"><span>${escapeHtml(qp.category)}</span><span>${escapeHtml(qp.difficulty)}</span></div>
      <h2>${escapeHtml(qp.questionText)}</h2>
      <div class="answers">
        ${qp.answers
          .map(
            (a, i) => `<button class="answer ${hidden.has(i) ? "hidden" : ""}" data-action="answer" data-index="${i}" ${hidden.has(i) ? "disabled" : ""}>${String.fromCharCode(65 + i)}. ${escapeHtml(a)}</button>`,
          )
          .join("")}
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="secondary" data-action="hint" ${state.personalHintUsed ? "disabled" : ""}>Hint (-1 point)</button>
        <button class="secondary" data-action="skip">Skip (${skipCount}/${state.skipVotes.threshold})</button>
        <input id="chatInput" placeholder='type "skip" then enter' />
      </div>
      ${state.hintPublic?.autoHintActive ? `<p><small class="muted">Auto hint active: points now 0.5x. ${escapeHtml(state.hintPublic.autoHintText || "")}</small></p>` : ""}
      ${qp.attribution ? `<div class="footer-credit">${escapeHtml(qp.attribution)}</div>` : ""}
    </div>
  `;
}

function resultsView() {
  const rp = state.resultsPublic;
  const winner = rp.winner;
  return `
    <div class="card">
      <h3>Results</h3>
      <p>Correct answer: <b>${escapeHtml(rp.correctAnswer || "")}</b></p>
      ${winner ? `<div class="winner"><div class="avatar">${winner.avatarUrl ? `<img src="${winner.avatarUrl}" width="42" height="42"/>` : winner.displayName.slice(0,1)}</div><div><b>${escapeHtml(winner.displayName)}</b><div><small class="muted">+${winner.pointsAwarded} points</small></div></div></div>` : "<p>No correct answers this round.</p>"}
      <div class="row" style="margin-top:12px;"><button data-action="next">Get New Trivia</button></div>
    </div>
  `;
}

function joinView() {
  return `
    <div class="card">
      <h1>Trivia</h1>
      <p>Play in Discord Activity or regular browser mode.</p>
      <div class="row">
        <input id="roomCode" placeholder="Room code" value="${escapeHtml(state.roomCodeInput)}" />
        <button id="joinRoom">Join room</button>
        <button id="createRoom" class="secondary">Create room</button>
      </div>
      <small class="muted">Browser room key format: public:&lt;code&gt;</small>
    </div>
  `;
}

function bindJoin() {
  document.querySelector("#roomCode")?.addEventListener("input", (e) => {
    state.roomCodeInput = e.target.value;
  });
  document.querySelector("#joinRoom")?.addEventListener("click", () => {
    const code = (state.roomCodeInput || "").trim().toLowerCase();
    if (!code) return;
    state.roomKey = `public:${code}`;
    connectWs();
    render();
  });
  document.querySelector("#createRoom")?.addEventListener("click", () => {
    const code = Math.random().toString(36).slice(2, 7);
    state.roomCodeInput = code;
    state.roomKey = `public:${code}`;
    connectWs();
    render();
  });
}

function bindActions() {
  document.querySelectorAll("[data-action='answer']").forEach((btn) => {
    btn.addEventListener("click", () => send({ type: "answer", answerIndex: Number(btn.dataset.index) }));
  });
  document.querySelector("[data-action='hint']")?.addEventListener("click", () => send({ type: "hint" }));
  document.querySelector("[data-action='skip']")?.addEventListener("click", () => send({ type: "skip" }));
  document.querySelector("[data-action='next']")?.addEventListener("click", () => send({ type: "next" }));
  document.querySelector("#chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      send({ type: "chat", text: e.target.value });
      e.target.value = "";
    }
  });
}

function send(payload) {
  if (!state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify({ v: 1, ...payload }));
}

function connectWs() {
  if (!state.roomKey || !state.user) return;
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;

  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  state.wsState = "connecting";
  render();

  ws.addEventListener("open", () => {
    state.wsState = "connected";
    send({ type: "join", roomKey: state.roomKey, user: state.user });
    render();
  });

  ws.addEventListener("close", () => {
    state.wsState = "reconnecting";
    render();
    setTimeout(connectWs, 1200);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "state") {
      if (msg.seq <= state.seq) return;
      const wasResults = state.phase === "results";
      state.seq = msg.seq;
      state.phase = msg.phase;
      state.players = msg.players || [];
      state.questionPublic = msg.questionPublic;
      state.timer = msg.timer;
      state.hintPublic = msg.hintPublic || state.hintPublic;
      state.skipVotes = msg.skipVotes || state.skipVotes;
      state.resultsPublic = msg.resultsPublic;
      state.personalHintUsed = false;
      state.hiddenAnswers = [];
      render();
      if (!wasResults && msg.phase === "results" && msg.resultsPublic?.winner) {
        confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
      }
    }
    if (msg.type === "hint_result") {
      state.personalHintUsed = true;
      const idx = state.questionPublic?.answers?.findIndex((a) => a === msg.removedAnswer);
      if (idx >= 0) state.hiddenAnswers.push(idx);
      render();
    }
  });
}

function guestIdentity() {
  const key = "trivia-guest-v1";
  const raw = localStorage.getItem(key);
  if (raw) return JSON.parse(raw);
  const id = crypto.randomUUID();
  const user = { userId: `guest:${id}`, displayName: `Guest-${id.slice(0, 5)}`, avatarUrl: "" };
  localStorage.setItem(key, JSON.stringify(user));
  return user;
}

async function init() {
  if (hasFrameId) {
    try {
      const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
      await sdk.ready();
      let auth;
      try {
        auth = await sdk.commands.authorize({ client_id: import.meta.env.VITE_DISCORD_CLIENT_ID, response_type: "code", state: "trivia", prompt: "none", scope: ["identify", "guilds", "applications.commands"] });
      } catch {
        auth = null;
      }
      if (auth?.code) {
        const tokenRes = await fetch(`${API_BASE}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: auth.code, game: "trivia" }) });
        const tjson = await tokenRes.json();
        if (tjson.access_token) {
          await sdk.commands.authenticate({ access_token: tjson.access_token });
        }
      }
      const user = await sdk.commands.getUser();
      const channel = await sdk.commands.getChannel({});
      state.user = { userId: user.id, displayName: user.global_name || user.username, avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : "" };
      const instanceId = q.get("instance_id") || q.get("instanceId");
      const guild = channel?.guild_id || q.get("guild_id");
      const channelId = channel?.id || q.get("channel_id");
      state.roomKey = instanceId || (guild && channelId ? `${guild}:${channelId}` : `activity:${sessionStorage.getItem("triviaRoom") || crypto.randomUUID()}`);
      sessionStorage.setItem("triviaRoom", state.roomKey.split(":").at(-1));
    } catch {
      state.mode = "browser";
      state.user = guestIdentity();
    }
  } else {
    state.user = guestIdentity();
  }

  render();
  if (state.roomKey) connectWs();
  setInterval(() => {
    if (state.roomKey) render();
  }, 250);
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

init();
