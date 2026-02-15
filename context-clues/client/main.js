import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");

const store = createStore({
  connection: "idle",
  profile: null,
  guildId: null,
  channelId: null,
  instanceId: null,
  state: null,
  banner: null,
  error: null,
  showHelp: false,
  showStats: false,
  stats: null,
});

let wsClient;

function avatarFallback(username = "?") {
  return username.slice(0, 1).toUpperCase();
}

function closenessPct(rank = 1000) {
  if (rank <= 1) return 100;
  return Math.round(Math.max(0, Math.min(100, 100 - Math.log10(rank) * 28)));
}

function guessRows(state) {
  const sorted = [...(state?.guesses || [])].sort((a, b) => a.rank - b.rank || b.ts - a.ts);
  return sorted
    .map((entry) => {
      const bar = closenessPct(entry.rank);
      return `<li class="guess-row ${entry.colorBand}">
        <div class="avatar-wrap">
          ${
            entry.user.avatarUrl
              ? `<img src="${entry.user.avatarUrl}" alt="${entry.user.username}" class="avatar-img"/>`
              : `<div class="avatar-fallback">${avatarFallback(entry.user.username)}</div>`
          }
        </div>
        <div class="word-wrap">
          <div class="word" title="${entry.word}">${entry.word}</div>
          <div class="meta">${entry.user.username}${entry.approx ? " · approx" : ""}</div>
          <div class="bar"><span style="width:${bar}%"></span></div>
        </div>
        <div class="rank">${entry.rank}</div>
      </li>`;
    })
    .join("");
}

function statsModal(view) {
  if (!view.showStats) return "";
  const you = view.stats?.you;
  const board = view.stats?.leaderboard || [];
  return `<section class="modal-backdrop" id="statsModal">
    <article class="modal-card">
      <h2>Your stats</h2>
      <ul class="stats-grid">
        <li>Games: <strong>${you?.gamesPlayed ?? 0}</strong></li>
        <li>Wins: <strong>${you?.wins ?? 0}</strong></li>
        <li>Points: <strong>${you?.points ?? 0}</strong></li>
        <li>Avg guesses to win: <strong>${you?.averageGuessesToWin ?? 0}</strong></li>
        <li>Best win guesses: <strong>${you?.bestWinGuesses ?? "-"}</strong></li>
        <li>Best rank achieved: <strong>${you?.closestRankAchieved ?? "-"}</strong></li>
      </ul>
      <h3>Channel leaderboard</h3>
      <ol class="leaderboard">${board
        .map((row) => `<li><span>${row.username}</span><strong>${row.wins}W · ${row.points}P</strong></li>`)
        .join("")}</ol>
      <button class="ghost" data-close="stats">Close</button>
    </article>
  </section>`;
}

function helpModal(view) {
  if (!view.showHelp) return "";
  return `<section class="modal-backdrop" id="helpModal">
    <article class="modal-card">
      <h2>How to play</h2>
      <p>Guess the secret word. Lower rank = closer. Rank 1 = exact.</p>
      <ul>
        <li><strong>Total guesses</strong>: every guess in this channel room.</li>
        <li><strong>Your guesses</strong>: only your guesses this round.</li>
        <li>Green rows are close, yellow are medium, red are far.</li>
      </ul>
      <button class="ghost" data-close="help">Got it</button>
    </article>
  </section>`;
}

function render(view) {
  const state = view.state;
  const total = state?.totals?.totalGuesses ?? 0;
  const yours = state?.totals?.yourGuesses ?? 0;

  app.innerHTML = `
    <main class="page">
      <header class="top">
        <div>
          <h1>Context Clues</h1>
          <p class="sub">Guess the hidden word by semantic proximity.</p>
        </div>
        <div class="header-actions">
          <button class="ghost" id="helpBtn">Help</button>
          <button class="ghost" id="statsBtn">Stats</button>
          <p class="status ${view.connection}">${view.connection}</p>
        </div>
      </header>

      <section class="counter-row">
        <p>Total guesses: <strong>${total}</strong></p>
        <p>Your guesses: <strong>${yours}</strong></p>
        <p>Round: <strong>${state?.roundId ?? "-"}</strong></p>
        <p>Semantic mode: <strong>${state?.semanticEnabled ? "ON" : "OFF (fallback)"}</strong></p>
      </section>

      <form id="guessForm" class="input-row">
        <input id="guessInput" placeholder="Type a word and hit Enter" maxlength="120" autocomplete="off" />
        <button>Guess</button>
      </form>

      ${view.banner ? `<section class="banner">${view.banner}</section>` : ""}
      ${view.error ? `<section class="error">${view.error}</section>` : ""}

      <ul class="guess-list">${guessRows(state)}</ul>
      ${helpModal(view)}
      ${statsModal(view)}
    </main>
  `;

  document.querySelector("#guessForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#guessInput");
    const word = input.value.trim();
    if (!word) return;
    wsClient.send({ t: "guess", word });
    input.value = "";
  });

  document.querySelector("#helpBtn")?.addEventListener("click", () => store.set({ showHelp: true }));
  document.querySelector("#statsBtn")?.addEventListener("click", () => {
    wsClient.send({ t: "stats" });
    store.set({ showStats: true });
  });
  document.querySelector('[data-close="help"]')?.addEventListener("click", () => store.set({ showHelp: false }));
  document
    .querySelector('[data-close="stats"]')
    ?.addEventListener("click", () => store.set({ showStats: false }));
}

store.subscribe(render);

async function safeJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${resp.status}): ${text.slice(0, 180)}`);
  }
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
  return {
    id: me.id,
    username: me.username,
    avatarUrl: discordAvatarUrl(me),
  };
}

function getContextIds() {
  const params = new URLSearchParams(location.search);
  const guildId = sdk.guildId || params.get("guild_id") || "browser-guild";
  const channelId = sdk.channelId || params.get("channel_id") || sdk.instanceId || "browser-channel";
  return { guildId: String(guildId), channelId: String(channelId) };
}

async function boot() {
  try {
    let profile;

    try {
      profile = await authenticate();
    } catch {
      const id = `browser-${Math.random().toString(16).slice(2, 8)}`;
      profile = { id, username: "Browser Tester", avatarUrl: "" };
    }

    const { guildId, channelId } = getContextIds();
    const instanceId = sdk.instanceId || "browser-instance";
    store.set({ profile, guildId, channelId, instanceId });

    wsClient = createWsClient({
      onStatus: (connection) => store.set({ connection }),
      getJoinPayload: () => ({ t: "join", v: 1, instanceId, guildId, channelId, user: profile }),
      onMessage: (msg) => {
        if (msg.t === "snapshot") {
          store.set({ state: msg.state, error: null });
        } else if (msg.t === "guess_result") {
          store.update((prev) => {
            const me = prev.profile?.id;
            const yourGuesses =
              (prev.state?.totals?.yourGuesses || 0) + (msg.entry?.user?.id === me ? 1 : 0);
            return {
              ...prev,
              state: {
                ...prev.state,
                guesses: [...(prev.state?.guesses || []), msg.entry].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
                totals: { totalGuesses: msg.totalGuesses, yourGuesses },
              },
              error: null,
            };
          });
        } else if (msg.t === "round_won") {
          store.set({
            banner: `${msg.winner.username} found it! Word was "${msg.word}" (+${msg.pointsAwarded} points).`,
          });
        } else if (msg.t === "new_round") {
          store.update((prev) => ({ ...prev, banner: `Round ${msg.roundId} started!`, error: null }));
        } else if (msg.t === "stats_view") {
          store.set({ stats: { you: msg.you, leaderboard: msg.leaderboard || [] }, showStats: true });
        } else if (msg.t === "error") {
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
