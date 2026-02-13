import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { createStore } from "./gameStore";
import { createWsClient } from "./wsClient";

const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
const app = document.querySelector("#app");

const store = createStore({
  sdkReady: false,
  authReady: false,
  connection: "idle",
  profile: null,
  instanceId: null,
  error: null,
  state: null,
  guessFeedback: null,
});

let wsClient;

function initials(name = "?") {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function phaseBody(state) {
  if (!state) return `<p class="muted">Waiting for room snapshot…</p>`;

  const { phase, current, players, you, role } = state;
  const isPlayer = role === "player";
  const me = players.find((player) => player.id === you);

  if (phase === "LOBBY") {
    const everyoneReady = players.filter((p) => !p.spectator).every((p) => p.ready);
    const enoughPlayers = players.filter((p) => !p.spectator).length >= 2;
    return `
      <section class="card">
        <h2>Lobby</h2>
        <p class="muted">Get everyone ready, then the host can launch the game.</p>
        <div class="row">
          ${
            isPlayer
              ? `<button data-act="toggle-ready" class="btn ${me?.ready ? "btn-ok" : ""}">${me?.ready ? "Ready ✓" : "Ready Up"}</button>`
              : `<span class="pill">Spectator mode</span>`
          }
          ${
            me?.isHost
              ? `<button data-act="start-game" class="btn" ${
                  everyoneReady && enoughPlayers ? "" : "disabled"
                }>Start Game</button>`
              : ""
          }
        </div>
      </section>
    `;
  }

  if (phase === "SUBMIT_CLUES") {
    return `
      <section class="card">
        <h2>Submit a clue</h2>
        <p class="muted">One clue each. No direct spoilers.</p>
        ${
          isPlayer
            ? `<form id="clueForm" class="row">
                <input id="clueInput" maxlength="90" placeholder="Enter your clue" value="${current.yourClue || ""}" ${
                current.yourClue ? "disabled" : ""
              } />
                <button class="btn" ${current.yourClue ? "disabled" : ""}>${
                current.yourClue ? "Submitted" : "Submit"
              }</button>
              </form>`
            : `<p class="pill">You joined mid-round and are spectating.</p>`
        }
        <p class="muted">Submitted: ${current.clueCount}</p>
      </section>
    `;
  }

  if (phase === "REVEAL_CLUES") {
    return `
      <section class="card">
        <h2>Clues revealed</h2>
        <div class="clues">
          ${current.revealedClues
            .map(
              (entry) => `<article class="clue"><small>${entry.username}</small><strong>${entry.clue}</strong></article>`,
            )
            .join("")}
        </div>
      </section>
    `;
  }

  if (phase === "GUESS") {
    return `
      <section class="card">
        <h2>Make your guess</h2>
        ${
          isPlayer
            ? `<form id="guessForm" class="row">
                <input id="guessInput" maxlength="90" placeholder="What is the secret?" value="${current.yourGuess || ""}" ${
                current.yourGuess ? "disabled" : ""
              }/>
                <button class="btn" ${current.yourGuess ? "disabled" : ""}>${
                current.yourGuess ? "Submitted" : "Guess"
              }</button>
              </form>`
            : `<p class="pill">Spectators can watch this round.</p>`
        }
        ${
          current.yourHint
            ? `<p class="hint">Hint: ${current.yourHint.label} (${current.yourHint.score}/100)</p>`
            : ""
        }
      </section>
    `;
  }

  if (phase === "SCORING") {
    const results = current.results || { guesses: {}, hints: {}, target: current.target };
    return `
      <section class="card">
        <h2>Round score</h2>
        <p>Secret: <strong>${results.target || "(hidden)"}</strong></p>
        <div class="scores">
          ${Object.entries(results.guesses || {})
            .map(([userId, guess]) => {
              const player = players.find((p) => p.id === userId);
              const hint = results.hints[userId];
              return `<div class="scoreLine"><span>${player?.username || "Unknown"}</span><span>${guess}</span><span>${hint?.score || 0}</span></div>`;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  return `<section class="card"><h2>${phase}</h2></section>`;
}

function renderPage(view) {
  const gameState = view.state;
  const players = gameState?.players || [];
  const timer = gameState?.timerRemaining;

  app.innerHTML = `
    <div class="layout">
      <header class="header">
        <div>
          <h1>Context Clues</h1>
          <p class="muted">Discord Activity MVP</p>
        </div>
        <div class="status ${view.connection}">${view.connection}</div>
      </header>

      <div class="content">
        <aside class="panel">
          <h3>Players</h3>
          <div class="list">
            ${players
              .map(
                (player) => `<div class="player ${player.connected ? "" : "offline"}">
                  <div class="avatar">${initials(player.username)}</div>
                  <div>
                    <strong>${player.username}</strong>
                    <div class="meta">
                      ${player.isHost ? '<span class="pill">Host</span>' : ""}
                      ${player.ready ? '<span class="pill ok">Ready</span>' : ""}
                      ${player.spectator ? '<span class="pill">Spectator</span>' : ""}
                    </div>
                  </div>
                  <span class="score">${player.score}</span>
                </div>`,
              )
              .join("")}
          </div>
        </aside>

        <main class="panel main">
          <div class="bar">
            <span>Phase: <strong>${gameState?.phase || "-"}</strong></span>
            <span>Round: <strong>${gameState?.round || 0}</strong></span>
            <span>Timer: <strong>${timer ?? "-"}</strong></span>
          </div>
          ${phaseBody(gameState)}
        </main>
      </div>

      <section class="panel chat">
        <h3>Chat</h3>
        <div id="chatLog" class="chatLog">
          ${(gameState?.chatLog || [])
            .map((line) => `<p><strong>${line.user.username}:</strong> ${line.text}</p>`)
            .join("")}
        </div>
        <form id="chatForm" class="row">
          <input id="chatInput" maxlength="180" placeholder="Message room"/>
          <button class="btn">Send</button>
        </form>
      </section>

      ${view.error ? `<p class="error">${view.error}</p>` : ""}
    </div>
  `;

  const clueForm = document.querySelector("#clueForm");
  if (clueForm) {
    clueForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const clue = document.querySelector("#clueInput").value;
      wsClient.send({ t: "submit_clue", clue });
    });
  }

  const guessForm = document.querySelector("#guessForm");
  if (guessForm) {
    guessForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const guess = document.querySelector("#guessInput").value;
      wsClient.send({ t: "submit_guess", guess });
    });
  }

  document.querySelector('[data-act="toggle-ready"]')?.addEventListener("click", () => {
    const me = gameState.players.find((player) => player.id === gameState.you);
    wsClient.send({ t: "ready", ready: !me?.ready });
  });

  document.querySelector('[data-act="start-game"]')?.addEventListener("click", () => {
    wsClient.send({ t: "start_game" });
  });

  document.querySelector("#chatForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    wsClient.send({ t: "chat", text });
    input.value = "";
  });
}

store.subscribe(renderPage);

async function safeJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${resp.status}): ${text.slice(0, 180)}`);
  }
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
  if (!token?.access_token) throw new Error("Token exchange failed.");

  await sdk.commands.authenticate({ access_token: token.access_token });

  const meResp = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  const me = await meResp.json();
  return {
    id: me.id,
    username: me.username,
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
      profile = { id: `browser-${Math.random().toString(16).slice(2, 8)}`, username: "Browser Tester" };
      instanceId = "browser-local-room";
    }

    store.set({ authReady: true, profile, instanceId });

    wsClient = createWsClient({
      onStatus: (connection) => store.set({ connection }),
      getJoinPayload: () => ({ t: "join", instanceId, user: profile }),
      onMessage: (msg) => {
        if (msg.t === "state_snapshot") {
          store.set({ state: msg.state, error: null });
        } else if (msg.t === "guess_feedback") {
          store.update((prev) => ({
            ...prev,
            state: {
              ...prev.state,
              current: {
                ...prev.state.current,
                yourHint: msg.hint,
              },
            },
          }));
        } else if (msg.t === "error") {
          store.set({ error: msg.error });
        }
      },
    });

    wsClient.connect();
  } catch (error) {
    store.set({ error: error.message || String(error) });
  }
}

boot();
