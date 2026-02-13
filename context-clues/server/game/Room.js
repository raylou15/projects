import { cleanText, PROTOCOL_VERSION } from "./protocol.js";
import { randomWord, similarityHint } from "./wordBank.js";

const PHASES = {
  LOBBY: "LOBBY",
  ROUND_SETUP: "ROUND_SETUP",
  SUBMIT_CLUES: "SUBMIT_CLUES",
  REVEAL_CLUES: "REVEAL_CLUES",
  GUESS: "GUESS",
  SCORING: "SCORING",
};

const DURATIONS = {
  SUBMIT_CLUES: 45,
  REVEAL_CLUES: 15,
  GUESS: 30,
  SCORING: 12,
};

const DISCONNECT_GRACE_MS = 30_000;
const CHAT_RATE_MS = 1200;

export class Room {
  constructor(instanceId, onEmpty) {
    this.instanceId = instanceId;
    this.onEmpty = onEmpty;
    this.players = new Map();
    this.sockets = new Set();
    this.socketMeta = new Map();
    this.pendingDisconnects = new Map();
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.round = 0;
    this.lastWords = [];
    this.timer = null;
    this.tickInterval = null;
    this.lastActivity = Date.now();
    this.chatLog = [];
    this.current = this.newRoundState();
  }

  newRoundState() {
    return {
      target: null,
      clues: {},
      guesses: {},
      hints: {},
      revealedClues: [],
      results: null,
    };
  }

  touch() {
    this.lastActivity = Date.now();
  }

  shouldExpire(now) {
    const idleMs = now - this.lastActivity;
    return this.sockets.size === 0 && idleMs > 5 * 60_000;
  }

  addSocket(ws) {
    this.sockets.add(ws);
    this.touch();
  }

  removeSocket(ws) {
    this.sockets.delete(ws);
    const meta = this.socketMeta.get(ws);
    if (meta?.userId) {
      const user = this.players.get(meta.userId);
      if (user) {
        user.connected = false;
        const timeout = setTimeout(() => {
          const current = this.players.get(meta.userId);
          if (current && !current.connected) {
            this.players.delete(meta.userId);
            this.ensureHost();
            this.broadcast({ t: "left", user: { id: meta.userId, username: user.username } });
            this.broadcastSnapshot();
            if (this.players.size === 0) {
              this.onEmpty(this.instanceId);
            }
          }
          this.pendingDisconnects.delete(meta.userId);
        }, DISCONNECT_GRACE_MS);
        this.pendingDisconnects.set(meta.userId, timeout);
      }
    }
    this.socketMeta.delete(ws);
    this.touch();
  }

  handleJoin(ws, payload) {
    const instanceId = cleanText(payload.instanceId, 128);
    const userId = cleanText(payload?.user?.id, 64);
    const username = cleanText(payload?.user?.username, 32);

    if (!instanceId || instanceId !== this.instanceId) {
      this.send(ws, { t: "error", error: "Bad instance id." });
      return;
    }
    if (!userId || !username) {
      this.send(ws, { t: "error", error: "Missing user id or username." });
      return;
    }

    this.socketMeta.set(ws, { userId });

    const existing = this.players.get(userId);
    if (existing) {
      existing.connected = true;
      existing.username = username;
      existing.lastSeen = Date.now();
      const pending = this.pendingDisconnects.get(userId);
      if (pending) {
        clearTimeout(pending);
        this.pendingDisconnects.delete(userId);
      }
    } else {
      const isLate = this.phase !== PHASES.LOBBY;
      this.players.set(userId, {
        id: userId,
        username,
        ready: false,
        connected: true,
        score: 0,
        spectator: isLate,
        joinedRound: this.round,
        lastSeen: Date.now(),
        lastChatAt: 0,
      });
      if (!isLate) {
        this.broadcast({ t: "joined", user: { id: userId, username } }, ws);
      }
    }

    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = userId;
    }

    this.send(ws, { t: "joined_ack", instanceId: this.instanceId, phase: this.phase });
    this.broadcastSnapshot();
    this.touch();
  }

  handleClientMessage(ws, msg) {
    const meta = this.socketMeta.get(ws);
    if (!meta?.userId) {
      this.send(ws, { t: "error", error: "Join first." });
      return;
    }

    const player = this.players.get(meta.userId);
    if (!player) {
      this.send(ws, { t: "error", error: "Unknown player." });
      return;
    }

    player.lastSeen = Date.now();
    this.touch();

    switch (msg.t) {
      case "leave":
        this.players.delete(player.id);
        this.ensureHost();
        this.broadcast({ t: "left", user: { id: player.id, username: player.username } });
        this.broadcastSnapshot();
        return;
      case "ready":
        if (this.phase !== PHASES.LOBBY) return;
        if (player.spectator) return;
        player.ready = !!msg.ready;
        this.broadcastSnapshot();
        return;
      case "start_game":
        if (!this.isHost(player.id)) return this.send(ws, { t: "error", error: "Host only." });
        if (!this.canStart()) return this.send(ws, { t: "error", error: "Everyone must be ready." });
        this.startRound();
        return;
      case "submit_clue":
        this.submitClue(ws, player, msg.clue);
        return;
      case "submit_guess":
        this.submitGuess(ws, player, msg.guess);
        return;
      case "next_phase":
        if (!this.isHost(player.id)) return this.send(ws, { t: "error", error: "Host only." });
        this.advancePhase(true);
        return;
      case "chat":
        this.submitChat(ws, player, msg.text);
        return;
      default:
        this.send(ws, { t: "error", error: "Unsupported action." });
    }
  }

  ensureHost() {
    if (this.hostId && this.players.has(this.hostId)) return;
    const next = [...this.players.values()].find((player) => !player.spectator) || [...this.players.values()][0];
    this.hostId = next?.id || null;
  }

  isHost(userId) {
    return this.hostId === userId;
  }

  canStart() {
    const active = [...this.players.values()].filter((player) => !player.spectator);
    return active.length >= 2 && active.every((player) => player.ready);
  }

  startRound() {
    this.round += 1;
    this.phase = PHASES.ROUND_SETUP;
    this.current = this.newRoundState();
    this.current.target = randomWord(this.lastWords);
    this.lastWords.push(this.current.target);
    this.lastWords = this.lastWords.slice(-8);

    [...this.players.values()].forEach((player) => {
      if (player.spectator) return;
      player.ready = false;
    });

    this.broadcastSnapshot();
    this.advancePhase();
  }

  submitClue(ws, player, clueInput) {
    if (this.phase !== PHASES.SUBMIT_CLUES) return;
    if (player.spectator) return;
    const clue = cleanText(clueInput, 90);
    if (!clue) return this.send(ws, { t: "error", error: "Clue cannot be empty." });
    this.current.clues[player.id] = clue;
    this.broadcast({ t: "update", key: "clue_count", value: Object.keys(this.current.clues).length });
    this.broadcastSnapshot();

    const needed = [...this.players.values()].filter((p) => !p.spectator).length;
    if (Object.keys(this.current.clues).length >= needed) {
      this.advancePhase();
    }
  }

  submitGuess(ws, player, guessInput) {
    if (this.phase !== PHASES.GUESS) return;
    if (player.spectator) return;
    const guess = cleanText(guessInput, 90);
    if (!guess) return this.send(ws, { t: "error", error: "Guess cannot be empty." });

    if (this.current.guesses[player.id]) {
      return this.send(ws, { t: "error", error: "Guess already submitted this round." });
    }

    const hint = similarityHint(guess, this.current.target);
    this.current.guesses[player.id] = guess;
    this.current.hints[player.id] = hint;

    if (hint.score === 100) {
      player.score += 12;
      this.advancePhase();
      return;
    }

    this.send(ws, { t: "guess_feedback", hint });
    const needed = [...this.players.values()].filter((p) => !p.spectator).length;
    if (Object.keys(this.current.guesses).length >= needed) {
      this.advancePhase();
    }
  }

  submitChat(ws, player, textInput) {
    const text = cleanText(textInput, 180);
    if (!text) return;
    const now = Date.now();
    if (now - player.lastChatAt < CHAT_RATE_MS) {
      return this.send(ws, { t: "error", error: "You're sending messages too quickly." });
    }

    player.lastChatAt = now;
    const line = { user: { id: player.id, username: player.username }, text, ts: now };
    this.chatLog.push(line);
    this.chatLog = this.chatLog.slice(-30);
    this.broadcast({ t: "chat", ...line });
  }

  advancePhase(force = false) {
    this.clearTimer();

    if (this.phase === PHASES.ROUND_SETUP) {
      this.phase = PHASES.SUBMIT_CLUES;
      this.startPhaseTimer(DURATIONS.SUBMIT_CLUES, () => this.advancePhase());
    } else if (this.phase === PHASES.SUBMIT_CLUES) {
      this.phase = PHASES.REVEAL_CLUES;
      this.current.revealedClues = Object.entries(this.current.clues).map(([userId, clue]) => ({
        userId,
        username: this.players.get(userId)?.username || "Unknown",
        clue,
      }));
      this.startPhaseTimer(DURATIONS.REVEAL_CLUES, () => this.advancePhase());
    } else if (this.phase === PHASES.REVEAL_CLUES) {
      this.phase = PHASES.GUESS;
      this.startPhaseTimer(DURATIONS.GUESS, () => this.advancePhase());
    } else if (this.phase === PHASES.GUESS || force) {
      this.phase = PHASES.SCORING;
      this.scoreRound();
      this.startPhaseTimer(DURATIONS.SCORING, () => this.finishScoring());
    }

    this.broadcast({ t: "phase_changed", phase: this.phase });
    this.broadcastSnapshot();
  }

  scoreRound() {
    const target = this.current.target;
    Object.entries(this.current.guesses).forEach(([userId, guess]) => {
      const player = this.players.get(userId);
      if (!player) return;
      const hint = this.current.hints[userId] || similarityHint(guess, target);
      if (hint.score >= 100) player.score += 8;
      else if (hint.score >= 75) player.score += 5;
      else if (hint.score >= 50) player.score += 3;
      else if (hint.score >= 25) player.score += 1;
    });

    Object.keys(this.current.clues).forEach((userId) => {
      const player = this.players.get(userId);
      if (player) player.score += 2;
    });

    this.current.results = {
      target,
      guesses: this.current.guesses,
      hints: this.current.hints,
    };
  }

  finishScoring() {
    if (this.round >= 6) {
      this.phase = PHASES.LOBBY;
      [...this.players.values()].forEach((player) => {
        player.ready = false;
        player.spectator = false;
      });
    } else {
      this.phase = PHASES.ROUND_SETUP;
      this.current = this.newRoundState();
      this.current.target = randomWord(this.lastWords);
      this.lastWords.push(this.current.target);
      this.lastWords = this.lastWords.slice(-8);
      this.advancePhase();
      return;
    }

    this.broadcast({ t: "phase_changed", phase: this.phase });
    this.broadcastSnapshot();
  }

  startPhaseTimer(seconds, done) {
    const endsAt = Date.now() + seconds * 1000;
    this.timer = { endsAt, done };

    this.tickInterval = setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      this.broadcast({ t: "timer_tick", phase: this.phase, remaining: left });
      if (left <= 0) {
        this.clearTimer();
        done();
      }
    }, 1000);
  }

  clearTimer() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.timer = null;
  }

  snapshotFor(userId) {
    const players = [...this.players.values()].map((player) => ({
      id: player.id,
      username: player.username,
      ready: player.ready,
      connected: player.connected,
      score: player.score,
      spectator: player.spectator,
      isHost: player.id === this.hostId,
    }));

    const role = this.players.get(userId)?.spectator ? "spectator" : "player";

    const safeCurrent = {
      revealedClues: this.current.revealedClues,
      clueCount: Object.keys(this.current.clues).length,
      yourClue: this.current.clues[userId] || null,
      yourGuess: this.current.guesses[userId] || null,
      yourHint: this.current.hints[userId] || null,
      results: this.phase === PHASES.SCORING ? this.current.results : null,
      target:
        this.phase === PHASES.SCORING || this.phase === PHASES.LOBBY
          ? this.current.target
          : null,
    };

    return {
      v: PROTOCOL_VERSION,
      t: "state_snapshot",
      state: {
        instanceId: this.instanceId,
        hostId: this.hostId,
        phase: this.phase,
        round: this.round,
        you: userId,
        role,
        players,
        current: safeCurrent,
        chatLog: this.chatLog,
        timerRemaining: this.timer
          ? Math.max(0, Math.ceil((this.timer.endsAt - Date.now()) / 1000))
          : null,
      },
    };
  }

  broadcastSnapshot() {
    this.sockets.forEach((socket) => {
      const meta = this.socketMeta.get(socket);
      if (!meta?.userId) return;
      this.send(socket, this.snapshotFor(meta.userId));
    });
  }

  send(ws, payload) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  }

  broadcast(payload, exceptSocket = null) {
    this.sockets.forEach((socket) => {
      if (socket === exceptSocket) return;
      this.send(socket, payload);
    });
  }
}

export { PHASES };
