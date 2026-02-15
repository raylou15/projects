import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";
import { getIcon } from "./icons";
import { renderSafeMarkdown } from "./markdown";
import { AUDIO_CONFIG } from "./audioConfig";
import { createAudioManager } from "./audioManager";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");
const audio = createAudioManager(AUDIO_CONFIG);
audio.setMusicTrack("default");

const store = createStore({
  connection: "idle",
  profile: null,
  roomKey: null,
  state: null,
  banner: null,
  hint: null,
  error: null,
  modal: null,
  helpMarkdown: "",
  localLastGuessId: null,
  localLastGuessEntry: null,
  composing: false,
});

let wsClient;

function colorForRank(rank) {
  if (!Number.isFinite(rank)) return "#efefef";
  if (rank <= 300) return "#8ce0ce";
  if (rank <= 2000) return "#f7e68a";
  if (rank <= 8000) return "#f4b07a";
  return "#d9d9d9";
}

function sortedGuesses(state) {
  return [...(state?.guesses || [])].sort((a, b) => a.rank - b.rank || b.ts - a.ts);
}

function controlButton(id, text, iconName) {
  const icon = getIcon(iconName, text);
  return `<button id="${id}" class="control-btn">${icon || `<span>${text}</span>`}</button>`;
}

function guessRows(view) {
  return sortedGuesses(view.state)
    .map((entry) => {
      const outlined = entry.id === view.localLastGuessId ? "local-recent" : "";
      return `<li class="guess-row ${outlined}" style="background:${colorForRank(entry.rank)}">
        <span class="guess-word">${entry.word}</span>
        <span class="guess-rank">${entry.rank}</span>
      </li>`;
    })
    .join("");
}

function modalMarkup(view) {
  if (!view.modal) return "";
  let body = "";
  if (view.modal === "help") {
    body = renderSafeMarkdown(view.helpMarkdown || "Help content unavailable.");
  }
  if (view.modal === "players") {
    const players = view.state?.players || [];
    body = `<ul>${players
      .map((player) => `<li>${player.username} ${player.connected ? "• online" : "• away"} (${player.guessCount || 0} guesses)</li>`)
      .join("")}</ul>`;
  }

  return `<div class="modal-backdrop" id="modalBackdrop">
    <section class="modal-card" role="dialog" aria-modal="true">
      <button id="closeModal" class="close-modal">×</button>
      ${body}
    </section>
  </div>`;
}

function render(view) {
  const attempts = view.state?.totals?.totalGuesses ?? 0;
  const soundState = audio.state();

  app.innerHTML = `
    <main class="page">
      <header class="header">
        <h1>CONTEXT CLUES</h1>
        <p class="attempts">ATTEMPTS: ${attempts}</p>
        <div class="control-bar">
          ${controlButton("helpBtn", "Help", "help")}
          ${controlButton("hintBtn", "Hint", "hint")}
          ${controlButton("playersBtn", "Players", "players")}
          ${controlButton("soundBtn", !soundState.unlocked ? "Sound Off" : soundState.muted ? "Mute" : "Sound", soundState.muted || !soundState.unlocked ? "mute" : "sound")}
        </div>
      </header>

      <form id="guessForm" class="input-row">
        <input id="guessInput" placeholder="Type a word" maxlength="120" autocomplete="off" />
      </form>

      ${view.localLastGuessEntry ? `<section class="latest" style="background:${colorForRank(view.localLastGuessEntry.rank)}"><strong>Latest:</strong> ${view.localLastGuessEntry.word} <span>#${view.localLastGuessEntry.rank}</span></section>` : ""}
      ${view.hint ? `<section class="hint-banner">Hint: <strong>${view.hint.hintWord}</strong>${view.hint.hintRank ? ` (#${view.hint.hintRank})` : ""}</section>` : ""}
      ${view.banner ? `<section class="banner">${view.banner}</section>` : ""}
      ${view.error ? `<section class="error">${view.error}</section>` : ""}

      <ul class="guess-list">${guessRows(view)}</ul>
      ${modalMarkup(view)}
    </main>
  `;

  const guessInput = document.querySelector("#guessInput");
  if (view.modal !== "help" && view.modal !== "players") setTimeout(() => guessInput?.focus(), 0);

  document.querySelector("#guessForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (store.get().composing) return;
    const word = guessInput.value.trim();
    if (!word) return;
    audio.unlockFromGesture();
    audio.playSfx("guess");
    wsClient.send({ t: "guess", word });
    guessInput.value = "";
    guessInput.focus();
  });

  guessInput?.addEventListener("compositionstart", () => store.set({ composing: true }));
  guessInput?.addEventListener("compositionend", () => store.set({ composing: false }));

  document.querySelector("#helpBtn")?.addEventListener("click", () => store.set({ modal: "help" }));
  document.querySelector("#playersBtn")?.addEventListener("click", () => store.set({ modal: "players" }));
  document.querySelector("#hintBtn")?.addEventListener("click", () => {
    audio.unlockFromGesture();
    wsClient.send({ t: "hint_request" });
  });
  document.querySelector("#soundBtn")?.addEventListener("click", () => {
    audio.unlockFromGesture();
    audio.toggleMuted();
    store.update((prev) => ({ ...prev }));
  });

  document.querySelector("#closeModal")?.addEventListener("click", () => store.set({ modal: null }));
  document.querySelector("#modalBackdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "modalBackdrop") store.set({ modal: null });
  });
}

store.subscribe(render);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (store.get().modal) return;
  if (target.closest(".modal-card")) return;
  document.querySelector("#guessInput")?.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && store.get().modal) {
    store.set({ modal: null });
    return;
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
          return;
        }
        if (msg.t === "room_state") {
          store.update((prev) => ({ ...prev, state: { ...(prev.state || {}), players: msg.players || [] } }));
          return;
        }
        if (msg.t === "guess_result") {
          store.update((prev) => {
            const isMine = msg.entry?.user?.id === prev.profile?.id;
            if (isMine) {
              audio.playSfx("guess");
            } else {
              audio.playSfx("otherGuess");
            }
            return {
              ...prev,
              state: {
                ...(prev.state || {}),
                guesses: [...(prev.state?.guesses || []), msg.entry].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
                totals: {
                  totalGuesses: msg.totalGuesses ?? ((prev.state?.totals?.totalGuesses || 0) + 1),
                  yourGuesses: (prev.state?.totals?.yourGuesses || 0) + (isMine ? 1 : 0),
                },
              },
              localLastGuessId: isMine ? msg.entry.id : prev.localLastGuessId,
              localLastGuessEntry: isMine ? msg.entry : prev.localLastGuessEntry,
              error: null,
            };
          });
          document.querySelector("#guessInput")?.focus();
          return;
        }
        if (msg.t === "hint_response") {
          if (msg.ok) {
            audio.playSfx("hint");
            store.set({ hint: { hintWord: msg.hintWord, hintRank: msg.hintRank }, error: null });
          } else {
            store.set({ error: msg.message || "Hint unavailable" });
            audio.playSfx("error");
          }
          return;
        }
        if (msg.t === "round_won") {
          audio.playSfx("correct");
          store.set({ banner: `${msg.winner.username} found it!`, hint: null });
          return;
        }
        if (msg.t === "new_round") {
          store.update((prev) => ({
            ...prev,
            banner: `Round ${msg.roundId} started`,
            hint: null,
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
