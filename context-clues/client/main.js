import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";
import { renderSafeMarkdown } from "./markdown";
import { AUDIO_CONFIG } from "./audioConfig";
import { createAudioManager } from "./audioManager";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");
const audio = createAudioManager(AUDIO_CONFIG);
audio.setMusicTrack("default");

const THEME_KEY = "context-clues-theme-v1";

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
  menuOpen: false,
  theme: loadTheme(),
});

let wsClient;

function rankTier(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return "unknown";
  if (rank <= 20) return "closest";
  if (rank <= 100) return "near";
  if (rank <= 500) return "warm";
  if (rank <= 2000) return "mid";
  return "far";
}

function fillWidth(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return 12;
  const raw = 100 - Math.log10(rank + 1) * 24;
  return Math.max(10, Math.min(92, Number(raw.toFixed(1))));
}

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

function rowMarkup(entry, outlined) {
  const tier = rankTier(entry.rank);
  const width = fillWidth(entry.rank);
  const rankLabel = Number.isFinite(entry.rank) ? `#${entry.rank}` : "—";
  const isHint = !!entry.isHint;
  const avatar = isHint
    ? `<span class="guess-avatar guess-avatar-fallback guess-avatar-hint">?</span>`
    : entry.user?.avatarUrl
      ? `<img class="guess-avatar" src="${entry.user.avatarUrl}" alt="" loading="lazy"/>`
      : `<span class="guess-avatar guess-avatar-fallback">${escapeHtml((entry.user?.username || "?").slice(0, 1).toUpperCase())}</span>`;

  return `<li class="guess-row tier-${tier} ${outlined ? "local-recent" : ""} ${isHint ? "guess-row-hint" : ""}">
      <div class="guess-fill" style="width:${width}%"></div>
      <div class="guess-content">
        <div class="guess-left">${avatar}<span class="guess-word">${escapeHtml(entry.word)}</span></div>
        <span class="guess-rank">${rankLabel}</span>
      </div>
    </li>`;
}

function guessRows(view) {
  return sortedGuesses(view.state)
    .map((entry) => rowMarkup(entry, entry.id === view.localLastGuessId))
    .join("");
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
      .map(
        (player) => `<li><span>${escapeHtml(player.username || "Unknown")}</span><span>${player.connected ? "online" : "away"}</span></li>`,
      )
      .join("")}</ul>`;
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

function menuMarkup(view) {
  if (!view.menuOpen) return "";
  const isMuted = audio.state().muted;
  return `<div class="menu-pop" id="menuPop" role="menu" aria-label="Game menu">
    <button class="menu-item" data-menu-action="help" role="menuitem">Help</button>
    <button class="menu-item" data-menu-action="hint" role="menuitem">Hint</button>
    <button class="menu-item" data-menu-action="players" role="menuitem">Players</button>
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
  applyTheme(view.theme);
  const attempts = view.state?.totals?.totalGuesses ?? 0;
  const roomTag = view.state?.roundId ? `GAME: #${view.state.roundId}` : "GAME: ----";

  app.innerHTML = `
    <main class="page">
      <header class="topbar">
        <h1>CONTEXT CLUES</h1>
        <button id="menuToggle" class="kebab-btn" aria-expanded="${view.menuOpen ? "true" : "false"}" aria-haspopup="menu" aria-label="Open menu">⋮</button>
        ${menuMarkup(view)}
      </header>

      <p class="stats-row">${roomTag} · ATTEMPTS: ${attempts}</p>

      <form id="guessForm" class="input-row">
        <input id="guessInput" placeholder="Type a word" maxlength="120" autocomplete="off" />
      </form>

      ${view.localLastGuessEntry ? `<section class="last-guess-wrap"><div class="section-label">LAST GUESS</div><ul class="guess-list pinned">${rowMarkup(view.localLastGuessEntry, false)}</ul></section>` : ""}
      ${view.banner ? `<section class="banner">${escapeHtml(view.banner)}</section>` : ""}
      ${view.error ? `<section class="error">${escapeHtml(view.error)}</section>` : ""}

      <div class="rankings-wrap">
        <div class="section-label">RANKINGS</div>
        <ul class="guess-list" id="guessList">${guessRows(view)}</ul>
      </div>
      ${modalMarkup(view)}
    </main>
  `;

  if (shouldRefocusInput(view)) setTimeout(refocusInput, 0);

  const guessInput = document.querySelector("#guessInput");

  document.querySelector("#guessForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (store.get().composing) return;
    const word = guessInput.value.trim();
    if (!word) return;
    audio.unlockFromGesture();
    audio.playSfx("guess");
    wsClient.send({ t: "guess", word });
    guessInput.value = "";
    if (shouldRefocusInput(store.get())) guessInput.focus();
  });

  guessInput?.addEventListener("compositionstart", () => store.set({ composing: true }));
  guessInput?.addEventListener("compositionend", () => store.set({ composing: false }));

  document.querySelector("#menuToggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    audio.unlockFromGesture();
    store.update((prev) => ({ ...prev, menuOpen: !prev.menuOpen }));
  });

  document.querySelectorAll("[data-menu-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = button.getAttribute("data-menu-action");
      audio.unlockFromGesture();
      audio.playSfx("uiClick");

      if (action === "help") store.set({ menuOpen: false, modal: "help" });
      if (action === "players") store.set({ menuOpen: false, modal: "players" });
      if (action === "hint") {
        wsClient.send({ t: "hint_request" });
        store.set({ menuOpen: false });
      }
      if (action === "sound") {
        audio.toggleMuted();
        store.update((prev) => ({ ...prev, menuOpen: false }));
      }
      if (action === "theme") {
        store.update((prev) => ({
          ...prev,
          menuOpen: false,
          theme: prev.theme === "light" ? "dark" : "light",
        }));
      }
    });
  });

  document.querySelector("#closeModal")?.addEventListener("click", () => {
    store.set({ modal: null });
    setTimeout(refocusInput, 0);
  });

  document.querySelector("#modalBackdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "modalBackdrop") {
      store.set({ modal: null });
      setTimeout(refocusInput, 0);
    }
  });
}

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
  if (target.closest(".modal-card")) return;
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
        profile: { id, username: "Browser Tester", avatarUrl: "" },
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
          store.set({ state: msg.state, error: null });
          if (shouldRefocusInput(store.get())) setTimeout(refocusInput, 0);
          return;
        }
        if (msg.t === "room_state") {
          store.update((prev) => ({ ...prev, state: { ...(prev.state || {}), players: msg.players || [] } }));
          return;
        }
        if (msg.t === "guess_result") {
          store.update((prev) => {
            const isMine = msg.entry?.user?.id === prev.profile?.id;
            if (!isMine) {
              audio.playSfx("otherGuess");
            }
            return {
              ...prev,
              state: {
                ...(prev.state || {}),
                guesses: [...(prev.state?.guesses || []), msg.entry].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
                totals: {
                  totalGuesses: msg.totalGuesses ?? (prev.state?.totals?.totalGuesses || 0) + 1,
                  yourGuesses: (prev.state?.totals?.yourGuesses || 0) + (isMine ? 1 : 0),
                },
              },
              localLastGuessId: isMine ? msg.entry.id : prev.localLastGuessId,
              localLastGuessEntry: isMine ? msg.entry : prev.localLastGuessEntry,
              error: null,
            };
          });
          if (shouldRefocusInput(store.get())) setTimeout(refocusInput, 0);
          return;
        }
        if (msg.t === "hint_response") {
          if (msg.ok) {
            audio.playSfx("hint");
            store.set({ error: null });
          } else {
            store.set({ error: msg.message || "Hint unavailable" });
            audio.playSfx("error");
          }
          if (shouldRefocusInput(store.get())) setTimeout(refocusInput, 0);
          return;
        }
        if (msg.t === "round_won") {
          audio.playSfx("correct");
          store.set({ banner: `${msg.winner.username} found it!` });
          return;
        }
        if (msg.t === "new_round") {
          store.update((prev) => ({
            ...prev,
            banner: `Round ${msg.roundId} started`,
                      localLastGuessId: null,
            localLastGuessEntry: null,
            error: null,
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
  } catch (error) {
    store.set({ error: error.message || String(error) });
  }
}

boot();
