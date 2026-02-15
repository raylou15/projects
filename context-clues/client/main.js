import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");

const store = createStore({
  connection: "idle",
  profile: null,
  instanceId: null,
  state: null,
  banner: null,
  error: null,
});

let wsClient;

function avatarFallback(username = "?") {
  return username.slice(0, 1).toUpperCase();
}

function closenessPct(rank = 1000) {
  if (rank <= 1) return 100;
  const score = Math.max(0, Math.min(100, 100 - Math.log10(rank) * 28));
  return Math.round(score);
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
        <p class="status ${view.connection}">${view.connection}</p>
      </header>

      <section class="counter-row">
        <p>Total guesses: <strong>${total}</strong></p>
        <p>Your guesses: <strong>${yours}</strong></p>
        <p>Round: <strong>${state?.roundId ?? "-"}</strong></p>
      </section>

      <form id="guessForm" class="input-row">
        <input id="guessInput" placeholder="type a word" maxlength="120" autocomplete="off" />
        <button>Guess</button>
      </form>

      ${view.banner ? `<section class="banner">${view.banner}</section>` : ""}
      ${view.error ? `<section class="error">${view.error}</section>` : ""}

      <ul class="guess-list">
        ${guessRows(state)}
      </ul>
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

async function boot() {
  try {
    let profile;
    let instanceId;

    try {
      profile = await authenticate();
      instanceId = sdk.instanceId;
    } catch {
      const id = `browser-${Math.random().toString(16).slice(2, 8)}`;
      profile = { id, username: "Browser Tester", avatarUrl: "" };
      instanceId = "browser-local-room";
    }

    store.set({ profile, instanceId });

    wsClient = createWsClient({
      onStatus: (connection) => store.set({ connection }),
      getJoinPayload: () => ({ t: "join", v: 1, instanceId, user: profile }),
      onMessage: (msg) => {
        if (msg.t === "snapshot") {
          store.set({ state: msg.state, error: null });
        } else if (msg.t === "guess_result") {
          store.update((prev) => ({
            ...prev,
            state: {
              ...prev.state,
              guesses: [...(prev.state?.guesses || []), msg.entry].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
              totals: msg.totals,
            },
            error: null,
          }));
        } else if (msg.t === "round_won") {
          store.set({
            banner: `${msg.winner.username} found it! Word was "${msg.word}". New round in ${Math.floor(msg.nextRoundInMs / 1000)}s`,
          });
        } else if (msg.t === "new_round") {
          store.update((prev) => ({ ...prev, banner: `Round ${msg.roundId} started!`, error: null }));
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
