import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";
import { renderSafeMarkdown } from "./markdown";
import { AUDIO_CONFIG } from "./audioConfig";
import { createAudioManager } from "./audioManager";
import { normalizeGuess } from "../shared/wordNormalize.js";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");
const audio = createAudioManager(AUDIO_CONFIG);
audio.setMusicTrack("default");

const THEME_KEY = "context-clues-theme-v1";
const TOAST_MS = 2500;

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "dark" ? "dark" : "light";
}

const store = createStore({
  connection: "idle",
  profile: null,
  roomKey: null,
  state: null,
  banner: null,
  error: null,
  modal: null,
  helpMarkdown: "",
  localLastGuessId: null,
  localLastGuessEntry: null,
  composing: false,
  draftGuess: "",
  draftSelStart: null,
  draftSelEnd: null,
  skipVote: null,
  skipCountdownTick: 0,
  menuOpen: false,
  theme: loadTheme(),
  win: null,
  toastQueue: [],
});

let wsClient;
let lastView = null;
let uiBound = false;
let toastTimer = null;
let winTimer = null;
let confettiTimer = null;

const DRAFT_STATE_KEYS = new Set(["draftGuess", "draftSelStart", "draftSelEnd", "composing"]);

function rankTier(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return "unknown";
  if (rank <= 20) return "closest";
  if (rank <= 100) return "near";
  if (rank <= 500) return "warm";
  if (rank <= 2000) return "mid";
  return "far";
}

function fillWidth(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return 11;
  if (rank === 1) return 100;

  const maxRank = 2000;
  const clamped = Math.max(1, Math.min(maxRank, rank));
  const progress = 1 - Math.log10(clamped) / Math.log10(maxRank);
  const width = 10 + progress * 90;
  return Math.max(10, Math.min(100, Number(width.toFixed(1))));
}

// Expected widths (approx): rank 1=100, 2=91.8, 5=80.7, 20=58.8, 100=37.2, 500=16.3, 2000=10

function sortedGuesses(state) {
  return [...(state?.guesses || [])].sort((a, b) => a.rank - b.rank || b.ts - a.ts);
}

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function playerAvatar(player) {
  return player?.avatarUrl
    ? `<img class="guess-avatar" src="${player.avatarUrl}" alt="" loading="lazy"/>`
    : `<span class="guess-avatar guess-avatar-fallback">${escapeHtml((player?.username || "?").slice(0, 1).toUpperCase())}</span>`;
}

function rowMarkup(entry, outlined) {
  const tier = rankTier(entry.rank);
  const width = fillWidth(entry.rank);
  const rankLabel = Number.isFinite(entry.rank) ? `#${entry.rank}` : "—";
  const isHint = entry.user?.id === "hint" || !!entry.isHint;
  const avatar = isHint
    ? `<span class="guess-avatar guess-avatar-fallback guess-avatar-hint">?</span>`
    : playerAvatar(entry.user);

  return `<li class="guess-row tier-${tier} ${outlined ? "local-recent" : ""} ${isHint ? "guess-row-hint" : ""}">
      <div class="guess-fill" style="width:${width}%"></div>
      <div class="guess-content">
        <div class="guess-left">${avatar}<span class="guess-word">${escapeHtml(String(entry.word || "").toLowerCase())}</span></div>
        <span class="guess-rank">${rankLabel}</span>
      </div>
    </li>`;
}

function guessRows(view) {
  return sortedGuesses(view.state)
    .map((entry) => rowMarkup(entry, entry.id === view.localLastGuessId))
    .join("");
}

function playerStatsLine(player) {
  const wins = player?.stats?.room?.wins ?? player?.stats?.wins ?? 0;
  const bestRank = player?.stats?.room?.bestRank ?? player?.stats?.bestRank;
  return `wins ${wins} · best ${bestRank ? `#${bestRank}` : "—"}`;
}

function modalMarkup(view) {
  if (!view.modal) return "";
  let title = "";
  let body = "";

  if (view.modal === "help") {
    title = "Help";
    body = renderSafeMarkdown(view.helpMarkdown || "Help content unavailable.");
  }

  if (view.modal === "players") {
    title = "Players";
    const players = view.state?.players || [];
    body = `<ul class="player-list">${players
      .map((player) => {
        const display = escapeHtml(player.nickname || player.username || "Unknown");
        const username = player.nickname ? `<span class="player-handle">@${escapeHtml(player.username || "")}</span>` : "";
        return `<li>
          <div class="player-main">${playerAvatar(player)}<div><strong>${display}</strong>${username}<div class="player-sub">${playerStatsLine(player)}</div></div></div>
          <span class="player-status ${player.connected ? "online" : "away"}">${player.connected ? "online" : "away"}</span>
        </li>`;
      })
      .join("")}</ul>`;
  }

  if (view.modal === "audio") {
    const state = audio.state();
    title = "Audio";
    body = `<div class="audio-panel">
      <label class="audio-row"><span>Mute</span><input id="audioMute" type="checkbox" ${state.muted ? "checked" : ""}/></label>
      <label class="audio-row"><span>SFX volume <b>${Math.round(state.sfxVolume * 100)}%</b></span><input id="sfxVolume" type="range" min="0" max="100" value="${Math.round(state.sfxVolume * 100)}"/></label>
      <label class="audio-row"><span>Music volume <b>${Math.round(state.musicVolume * 100)}%</b></span><input id="musicVolume" type="range" min="0" max="100" value="${Math.round(state.musicVolume * 100)}"/></label>
      <button id="testSfx" class="menu-item audio-test">Test SFX</button>
    </div>`;
  }

  return `<div class="modal-backdrop" id="modalBackdrop">
    <section class="modal-card" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="modal-header">
        <h2>${title}</h2>
        <button id="closeModal" class="close-modal" aria-label="Close">×</button>
      </header>
      <div class="modal-body">${body}</div>
    </section>
  </div>`;
}

function winOverlayMarkup(view) {
  if (!view.win) return "";
  const winnerName = escapeHtml(view.win.winner?.nickname || view.win.winner?.username || "Someone");
  const winnerUser = view.win.winner?.nickname ? `<div class="win-sub">@${escapeHtml(view.win.winner.username || "")}</div>` : "";
  return `<div class="win-overlay">
    <canvas id="confettiCanvas" class="confetti-canvas" width="800" height="600"></canvas>
    <section class="win-card">
      <div class="win-user">${playerAvatar(view.win.winner)}<div><strong>${winnerName}</strong>${winnerUser}</div></div>
      <p class="win-line">found the word: <b>${escapeHtml(String(view.win.word || "").toUpperCase())}</b></p>
      <p class="win-line">Next round starts in ${view.win.secondsLeft}s</p>
    </section>
  </div>`;
}

function toastMarkup(view) {
  return `<div class="toast-stack">${(view.toastQueue || [])
    .map((toast) => `<div class="event-toast">${escapeHtml(toast.text)}</div>`)
    .join("")}</div>`;
}

function menuMarkup(view) {
  if (!view.menuOpen) return "";
  const isMuted = audio.state().muted;
  return `<div class="menu-pop" id="menuPop" role="menu" aria-label="Game menu">
    <button class="menu-item" data-menu-action="help" role="menuitem">Help</button>
    <button class="menu-item" data-menu-action="hint" role="menuitem">Hint</button>
    <button class="menu-item" data-menu-action="skip" role="menuitem">Skip</button>
    <button class="menu-item" data-menu-action="players" role="menuitem">Players</button>
    <button class="menu-item" data-menu-action="audio" role="menuitem">Audio</button>
    <button class="menu-item" data-menu-action="terms" role="menuitem">Terms</button>
    <button class="menu-item" data-menu-action="privacy" role="menuitem">Privacy</button>
    <button class="menu-item" data-menu-action="sound" role="menuitem">Sound: ${isMuted ? "Muted" : "On"}</button>
    <button class="menu-item" data-menu-action="theme" role="menuitem">Theme: ${view.theme === "light" ? "Light" : "Dark"}</button>
  </div>`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}

function shouldRefocusInput(view) {
  return !view.modal && !view.menuOpen;
}

function refocusInput() {
  const input = document.querySelector("#guessInput");
  if (!input) return;
  input.focus();
}

function render(view) {
  if (onlyDraftStateChanged(lastView, view)) {
    lastView = view;
    return;
  }

  const previousInput = document.querySelector("#guessInput");
  const previousFocused = previousInput instanceof HTMLInputElement && document.activeElement === previousInput;
  const previousSelectionStart = previousInput instanceof HTMLInputElement ? previousInput.selectionStart : null;
  const previousSelectionEnd = previousInput instanceof HTMLInputElement ? previousInput.selectionEnd : null;
  const liveDraft = previousInput instanceof HTMLInputElement ? previousInput.value : null;
  const renderView =
    typeof liveDraft === "string" && view.draftGuess !== liveDraft
      ? { ...view, draftGuess: liveDraft }
      : view;

  applyTheme(view.theme);
  const attempts = renderView.state?.totals?.totalGuesses ?? 0;
  const roomTag = renderView.state?.roundId ? `GAME: #${renderView.state.roundId}` : "GAME: ----";
  const skipStatus = renderView.skipVote
    ? `<p class="stats-row skip-row">Skip vote: ${renderView.skipVote.votes}/${renderView.skipVote.needed} (${secondsLeft(renderView.skipVote.expiresAt)}s)</p>`
    : "";

  app.innerHTML = `
    <main class="page">
      <header class="topbar">
        <h1>CONTEXT CLUES</h1>
        <button id="menuToggle" class="kebab-btn" aria-expanded="${renderView.menuOpen ? "true" : "false"}" aria-haspopup="menu" aria-label="Open menu">⋮</button>
        ${menuMarkup(renderView)}
      </header>

      <p class="stats-row">${roomTag} · ATTEMPTS: ${attempts}</p>
      ${skipStatus}

      <form id="guessForm" class="input-row">
        <input id="guessInput" placeholder="Type a word" maxlength="120" autocomplete="off" />
      </form>

      ${renderView.localLastGuessEntry ? `<section class="last-guess-wrap"><div class="section-label">LAST GUESS</div><ul class="guess-list pinned">${rowMarkup(renderView.localLastGuessEntry, false)}</ul></section>` : ""}
      ${renderView.banner ? `<section class="banner">${escapeHtml(renderView.banner)}</section>` : ""}
      ${renderView.error ? `<section class="error">${escapeHtml(renderView.error)}</section>` : ""}

      <div class="rankings-wrap">
        <div class="section-label">RANKINGS</div>
        <ul class="guess-list" id="guessList">${guessRows(renderView)}</ul>
      </div>
      ${toastMarkup(renderView)}
      ${modalMarkup(renderView)}
      ${winOverlayMarkup(renderView)}
    </main>
  `;

  const guessInput = document.querySelector("#guessInput");
  const stableInput = previousInput instanceof HTMLInputElement ? previousInput : guessInput;
  if (previousInput instanceof HTMLInputElement && guessInput instanceof HTMLInputElement && previousInput !== guessInput) {
    guessInput.replaceWith(previousInput);
  }

  restoreDraft(renderView, stableInput);

  if (previousFocused && stableInput instanceof HTMLInputElement) {
    stableInput.focus({ preventScroll: true });
    if (Number.isInteger(previousSelectionStart) && Number.isInteger(previousSelectionEnd)) {
      try {
        stableInput.setSelectionRange(previousSelectionStart, previousSelectionEnd);
      } catch {
        // no-op
      }
    }
  }

  if (view.win) paintConfetti();
  lastView = view;
}

function onlyDraftStateChanged(prev, next) {
  if (!prev) return false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  let changedDraft = false;
  for (const key of keys) {
    if (prev[key] === next[key]) continue;
    if (!DRAFT_STATE_KEYS.has(key)) return false;
    changedDraft = true;
  }
  return changedDraft;
}

function secondsLeft(expiresAt) {
  if (!expiresAt || !Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function restoreDraft(view, input) {
  if (!input) return;
  const draft = view.draftGuess || "";
  if (input.value !== draft) input.value = draft;

  const start = view.draftSelStart;
  const end = view.draftSelEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;

  const safeStart = Math.max(0, Math.min(start, input.value.length));
  const safeEnd = Math.max(0, Math.min(end, input.value.length));
  const isFocused = document.activeElement === input;
  if (view.composing && isFocused) return;

  const selectionChanged = input.selectionStart !== safeStart || input.selectionEnd !== safeEnd;
  if (!selectionChanged) return;

  try {
    input.setSelectionRange(safeStart, safeEnd);
  } catch {
    // no-op
  }
}

function captureDraftState(input) {
  if (!input) return;
  const next = {
    draftGuess: input.value,
    draftSelStart: input.selectionStart,
    draftSelEnd: input.selectionEnd,
  };

  const current = store.get();
  if (
    current.draftGuess === next.draftGuess &&
    current.draftSelStart === next.draftSelStart &&
    current.draftSelEnd === next.draftSelEnd
  ) {
    return;
  }
  store.set(next);
}

function enqueueToast(text) {
  const stamp = Date.now();
  store.update((prev) => {
    const recent = prev.toastQueue.filter((toast) => stamp - toast.ts < TOAST_MS && toast.text === text);
    if (recent.length) return prev;
    const queue = [...prev.toastQueue, { id: `${stamp}-${Math.random()}`, text, ts: stamp }].slice(-4);
    return { ...prev, toastQueue: queue };
  });

  if (!toastTimer) {
    toastTimer = setInterval(() => {
      store.update((prev) => ({ ...prev, toastQueue: prev.toastQueue.filter((toast) => Date.now() - toast.ts < TOAST_MS) }));
      if (!(store.get().toastQueue || []).length) {
        clearInterval(toastTimer);
        toastTimer = null;
      }
    }, 300);
  }
}

function startWinCountdown(payload) {
  if (winTimer) clearInterval(winTimer);
  const nextRoundAt = payload.nextRoundAt || Date.now() + (payload.nextRoundInMs || 8000);

  store.set({
    win: {
      winner: payload.winner,
      word: payload.word,
      nextRoundAt,
      secondsLeft: secondsLeft(nextRoundAt),
    },
  });

  winTimer = setInterval(() => {
    const current = store.get().win;
    if (!current) return;
    const left = secondsLeft(current.nextRoundAt);
    store.update((prev) => ({ ...prev, win: prev.win ? { ...prev.win, secondsLeft: left } : null }));
    if (left <= 0) {
      clearInterval(winTimer);
      winTimer = null;
    }
  }, 250);
}

function paintConfetti() {
  if (confettiTimer) return;
  const canvas = document.querySelector("#confettiCanvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width));
  canvas.height = Math.max(320, Math.floor(rect.height));
  const pieces = Array.from({ length: 100 }).map(() => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height,
    w: 4 + Math.random() * 6,
    h: 8 + Math.random() * 12,
    v: 2 + Math.random() * 3,
    r: Math.random() * Math.PI,
    c: ["#2bb673", "#35b7a2", "#f1c65b", "#f09b5c", "#d48ad8"][Math.floor(Math.random() * 5)],
  }));

  const endAt = Date.now() + 2600;
  confettiTimer = setInterval(() => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      p.y += p.v;
      p.r += 0.1;
      if (p.y > canvas.height + 20) p.y = -20;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });

    if (Date.now() >= endAt) {
      clearInterval(confettiTimer);
      confettiTimer = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, 30);
}

function bindUIOnce() {
  if (uiBound) return;
  uiBound = true;

  app.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id !== "guessForm") return;

    event.preventDefault();
    const guessInput = document.querySelector("#guessInput");
    if (!guessInput || store.get().composing) return;

    const word = guessInput.value.trim();
    if (!word) return;
    const latest = store.get();
    const mine = (latest.state?.guesses || []).filter((entry) => entry?.user?.id === latest.profile?.id);
    const already = new Set(
      mine.map((entry) => entry.canonical || normalizeGuess(entry.word || "").canonical).filter(Boolean),
    );
    const normalized = normalizeGuess(word);
    if (normalized.canonical && already.has(normalized.canonical)) {
      store.set({ error: `${latest.profile?.username || "Player"} guessed ${normalized.display || word} already` });
      audio.playSfx("error");
      return;
    }

    audio.unlockFromGesture();
    audio.playSfx("guess");
    wsClient.send({ t: "guess", word });

    if (shouldRefocusInput(store.get())) guessInput.focus();
  });

  app.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "guessInput") captureDraftState(target);
    if (target instanceof HTMLInputElement && target.id === "sfxVolume") {
      audio.setSfxVolume(Number(target.value) / 100);
      store.update((prev) => ({ ...prev }));
    }
    if (target instanceof HTMLInputElement && target.id === "musicVolume") {
      audio.setMusicVolume(Number(target.value) / 100);
      store.update((prev) => ({ ...prev }));
    }
    if (target instanceof HTMLInputElement && target.id === "audioMute") {
      audio.setMuted(target.checked);
      store.update((prev) => ({ ...prev }));
    }
  });

  app.addEventListener("compositionstart", (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.id !== "guessInput") return;
    store.set({ composing: true });
  });
  app.addEventListener("compositionend", (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.id !== "guessInput") return;
    store.set({ composing: false });
    captureDraftState(event.target);
  });

  ["keydown", "keyup", "select", "click"].forEach((eventName) => {
    app.addEventListener(eventName, (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.id !== "guessInput") return;
      captureDraftState(event.target);
    });
  });

  app.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.id === "menuToggle") {
      event.stopPropagation();
      audio.unlockFromGesture();
      store.update((prev) => ({ ...prev, menuOpen: !prev.menuOpen }));
      return;
    }

    if (target.id === "closeModal" || target.id === "modalBackdrop") {
      store.set({ modal: null });
      setTimeout(refocusInput, 0);
      return;
    }

    if (target.id === "testSfx") {
      audio.unlockFromGesture();
      audio.playSfx("uiClick");
      return;
    }

    const menuButton = target.closest("[data-menu-action]");
    if (!(menuButton instanceof HTMLElement)) return;

    event.stopPropagation();
    const action = menuButton.getAttribute("data-menu-action");
    audio.unlockFromGesture();
    audio.playSfx("uiClick");

    if (action === "help") store.set({ menuOpen: false, modal: "help" });
    if (action === "players") store.set({ menuOpen: false, modal: "players" });
    if (action === "audio") store.set({ menuOpen: false, modal: "audio" });
    if (action === "hint") {
      wsClient.send({ t: "hint_request" });
      store.set({ menuOpen: false });
    }
    if (action === "skip") {
      wsClient.send({ t: "skip_request" });
      store.set({ menuOpen: false });
    }
    if (action === "terms") {
      window.open("/terms/", "_blank", "noopener");
      store.set({ menuOpen: false });
    }
    if (action === "privacy") {
      window.open("/privacy/", "_blank", "noopener");
      store.set({ menuOpen: false });
    }
    if (action === "sound") {
      audio.toggleMuted();
      store.update((prev) => ({ ...prev, menuOpen: false }));
    }
    if (action === "theme") {
      store.update((prev) => ({ ...prev, menuOpen: false, theme: prev.theme === "light" ? "dark" : "light" }));
    }
  });
}

bindUIOnce();
store.subscribe(render);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const view = store.get();
  if (view.menuOpen && !target.closest("#menuPop") && !target.closest("#menuToggle")) {
    store.set({ menuOpen: false });
    return;
  }
  if (view.modal) return;
  if (!target.closest("#menuPop") && !target.closest("#menuToggle")) refocusInput();
});

document.addEventListener("keydown", (event) => {
  const view = store.get();
  if (event.key === "Escape") {
    if (view.modal) {
      store.set({ modal: null });
      setTimeout(refocusInput, 0);
      return;
    }
    if (view.menuOpen) {
      store.set({ menuOpen: false });
      setTimeout(refocusInput, 0);
      return;
    }
  }
  if (!audio.state().unlocked) audio.unlockFromGesture();
});

async function safeJson(resp) {
  const text = await resp.text();
  return JSON.parse(text);
}

function discordAvatarUrl(user) {
  if (!user?.id || !user?.avatar) return "";
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

async function authenticate() {
  await sdk.ready();
  let code;
  try {
    ({ code } = await sdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: "code",
      prompt: "none",
      scope: ["identify"],
    }));
  } catch {
    ({ code } = await sdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: "code",
      prompt: "consent",
      scope: ["identify"],
    }));
  }

  const tokenResp = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  const token = await safeJson(tokenResp);
  await sdk.commands.authenticate({ access_token: token.access_token });

  const meResp = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  const me = await meResp.json();
  const channelId = sdk.channelId || "browser-room";
  const guildId = sdk.guildId || "browser-guild";
  return {
    profile: {
      id: me.id,
      username: me.username,
      nickname: "",
      avatarUrl: discordAvatarUrl(me),
    },
    roomKey: `${guildId}:${channelId}`,
    guildId,
    channelId,
    instanceId: sdk.instanceId,
  };
}

async function loadHelpMarkdown() {
  try {
    const resp = await fetch("/api/help");
    const json = await safeJson(resp);
    store.set({ helpMarkdown: json.markdown || "" });
  } catch {
    store.set({ helpMarkdown: "## Help\n- Guess the hidden word.\n- Lower ranks are closer." });
  }
}

async function boot() {
  await loadHelpMarkdown();
  try {
    let auth;
    try {
      auth = await authenticate();
    } catch {
      const id = `browser-${Math.random().toString(16).slice(2, 8)}`;
      auth = {
        profile: { id, username: "Browser Tester", nickname: "", avatarUrl: "" },
        roomKey: "browser-room",
        guildId: "browser-guild",
        channelId: "browser-channel",
        instanceId: "browser-instance",
      };
    }

    store.set({ profile: auth.profile, roomKey: auth.roomKey });

    wsClient = createWsClient({
      onStatus: (connection) => store.set({ connection }),
      getJoinPayload: () => ({
        t: "join",
        v: 1,
        roomKey: auth.roomKey,
        guildId: auth.guildId,
        channelId: auth.channelId,
        instanceId: auth.instanceId,
        user: auth.profile,
      }),
      onMessage: (msg) => {
        if (msg.t === "snapshot") {
          store.set({
            state: msg.state,
            error: null,
            skipVote: msg.state?.skipVote || null,
            win: msg.state?.roundEnded && msg.state?.nextRoundAt ? store.get().win : null,
          });
          return;
        }
        if (msg.t === "room_state") {
          store.update((prev) => ({ ...prev, state: { ...(prev.state || {}), players: msg.players || [], roundId: msg.roundId } }));
          return;
        }
        if (msg.t === "player_joined") {
          enqueueToast(`${msg.user?.nickname || msg.user?.username || "Someone"} joined`);
          return;
        }
        if (msg.t === "player_left") {
          enqueueToast(`${msg.user?.nickname || msg.user?.username || "Someone"} left`);
          return;
        }
        if (msg.t === "guess_result") {
          const isHint = msg.entry?.user?.id === "hint" || !!msg.entry?.isHint;

          store.update((prev) => {
            const isMine = msg.entry?.user?.id === prev.profile?.id;
            if (isHint) audio.playSfx("hint");
            else if (!isMine) audio.playSfx("otherGuess");

            return {
              ...prev,
              state: {
                ...(prev.state || {}),
                guesses: (() => {
                  const list = [...(prev.state?.guesses || [])];
                  if (!list.some((entry) => entry?.id === msg.entry?.id)) list.push(msg.entry);
                  return list.sort((a, b) => a.rank - b.rank || b.ts - a.ts);
                })(),
                totals: {
                  totalGuesses: msg.totalGuesses ?? (prev.state?.totals?.totalGuesses || 0) + 1,
                  yourGuesses: (prev.state?.totals?.yourGuesses || 0) + (isMine ? 1 : 0),
                },
              },
              localLastGuessId: isMine ? msg.entry.id : prev.localLastGuessId,
              localLastGuessEntry: isMine ? msg.entry : prev.localLastGuessEntry,
              error: null,
              draftGuess: isMine ? "" : prev.draftGuess,
              draftSelStart: isMine ? null : prev.draftSelStart,
              draftSelEnd: isMine ? null : prev.draftSelEnd,
            };
          });

          return;
        }
        if (msg.t === "hint_response") {
          if (!msg.ok) {
            store.set({ error: msg.message || "Hint unavailable" });
            audio.playSfx("error");
          }
          return;
        }
        if (msg.t === "round_won") {
          audio.playSfx("correct");
          startWinCountdown(msg);
          store.set({ banner: `${msg.winner.nickname || msg.winner.username} found it!` });
          return;
        }
        if (msg.t === "skip_status") {
          store.set({
            skipVote: {
              votes: msg.votes ?? 0,
              needed: msg.needed ?? 0,
              voters: msg.voters || [],
              expiresAt: msg.expiresAt ?? Date.now(),
            },
          });
          return;
        }
        if (msg.t === "skip_denied") {
          audio.playSfx("error");
          store.set({ skipVote: null, banner: msg.message || "Skip unavailable" });
          return;
        }
        if (msg.t === "skip_passed") {
          audio.playSfx("correct");
          store.set({ skipVote: null, banner: `Round skipped by ${msg.by?.username || "players"}` });
          return;
        }
        if (msg.t === "new_round") {
          if (winTimer) {
            clearInterval(winTimer);
            winTimer = null;
          }
          store.update((prev) => ({
            ...prev,
            banner: `Round ${msg.roundId} started`,
            win: null,
            localLastGuessId: null,
            localLastGuessEntry: null,
            error: null,
            skipVote: null,
            state: { ...(prev.state || {}), roundId: msg.roundId, roundEnded: false, nextRoundAt: null },
          }));
          return;
        }
        if (msg.t === "error") {
          audio.playSfx("error");
          store.set({ error: msg.message || "Server error" });
        }
      },
    });

    wsClient.connect();

    setInterval(() => {
      const current = store.get();
      if (!current.skipVote) return;
      store.set({ skipCountdownTick: current.skipCountdownTick + 1 });
    }, 1000);
  } catch (error) {
    store.set({ error: error.message || String(error) });
  }
}

boot();
