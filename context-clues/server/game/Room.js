import { cleanText, PROTOCOL_VERSION } from "./protocol.js";

const MAX_GUESSES = 200;
const NEXT_ROUND_DELAY_MS = 5_000;
const ROOM_TTL_MS = 10 * 60_000;

function makeId(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export class Room {
  constructor(instanceId, similarityService) {
    this.instanceId = instanceId;
    this.similarityService = similarityService;
    this.players = new Map();
    this.sockets = new Set();
    this.socketToUser = new Map();
    this.totalGuesses = 0;
    this.guessEntries = [];
    this.roundId = 0;
    this.targetWord = "";
    this.rankMap = new Map();
    this.simsSorted = [];
    this.evaluateGuess = null;
    this.semanticEnabled = false;
    this.nextRoundTimer = null;
    this.lastActivity = Date.now();

    this.startNewRound();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  shouldExpire(now = Date.now()) {
    return this.sockets.size === 0 && now - this.lastActivity > ROOM_TTL_MS;
  }

  addSocket(ws) {
    this.sockets.add(ws);
    this.touch();
  }

  removeSocket(ws) {
    this.sockets.delete(ws);
    const userId = this.socketToUser.get(ws);
    if (userId) {
      const player = this.players.get(userId);
      if (player) player.connected = false;
    }
    this.socketToUser.delete(ws);
    this.touch();
  }

  handleJoin(ws, msg) {
    const userId = cleanText(msg?.user?.id, 64);
    const username = cleanText(msg?.user?.username, 50);
    const avatarUrl = cleanText(msg?.user?.avatarUrl, 500);

    if (!userId || !username) {
      this.send(ws, { t: "error", message: "join requires user id + username" });
      return;
    }

    const existing = this.players.get(userId);
    if (existing) {
      existing.username = username;
      existing.avatarUrl = avatarUrl || existing.avatarUrl || "";
      existing.connected = true;
    } else {
      this.players.set(userId, {
        id: userId,
        username,
        avatarUrl: avatarUrl || "",
        guessCount: 0,
        connected: true,
      });
    }

    this.socketToUser.set(ws, userId);
    this.send(ws, { t: "snapshot", state: this.snapshotFor(userId) });
    this.touch();
  }

  handleClientMessage(ws, msg) {
    const userId = this.socketToUser.get(ws);
    if (!userId) {
      this.send(ws, { t: "error", message: "Join first." });
      return;
    }

    if (msg.t === "guess") {
      const word = cleanText(msg.word, 120);
      this.submitGuess(userId, word);
      return;
    }

    this.send(ws, { t: "error", message: `Unsupported action: ${msg.t}` });
  }

  startNewRound() {
    this.roundId += 1;
    this.totalGuesses = 0;
    this.guessEntries = [];
    this.players.forEach((player) => {
      player.guessCount = 0;
    });

    this.targetWord = this.similarityService.pickTarget();
    const roundData = this.similarityService.buildRound(this.targetWord);
    this.targetWord = roundData.targetWord;
    this.rankMap = roundData.rankMap;
    this.simsSorted = roundData.simsSorted;
    this.semanticEnabled = roundData.semantic;
    this.evaluateGuess = roundData.evaluateGuess;

    this.broadcast({ t: "new_round", roundId: this.roundId });
    this.broadcastSnapshot();
    this.touch();
  }

  submitGuess(userId, rawWord) {
    if (!rawWord) {
      this.broadcastToUser(userId, { t: "error", message: "type a word" });
      return;
    }

    const player = this.players.get(userId);
    if (!player) return;

    const result = this.evaluateGuess(rawWord);
    if (result.error) {
      this.broadcastToUser(userId, { t: "error", message: result.error });
      return;
    }

    this.totalGuesses += 1;
    player.guessCount += 1;

    const entry = {
      id: makeId("guess"),
      user: {
        id: player.id,
        username: player.username,
        avatarUrl: player.avatarUrl,
      },
      word: rawWord,
      rank: result.rank,
      approx: !!result.approx,
      similarity: Number(result.similarity.toFixed(5)),
      colorBand: result.colorBand,
      ts: Date.now(),
    };

    this.guessEntries.push(entry);
    if (this.guessEntries.length > MAX_GUESSES) {
      this.guessEntries = this.guessEntries.slice(-MAX_GUESSES);
    }

    const totals = this.totalsFor(userId);
    this.broadcast({ t: "guess_result", entry, totals });

    if (entry.rank === 1) {
      this.broadcast({
        t: "round_won",
        winner: entry.user,
        word: this.targetWord,
        nextRoundInMs: NEXT_ROUND_DELAY_MS,
      });

      if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = setTimeout(() => {
        this.nextRoundTimer = null;
        this.startNewRound();
      }, NEXT_ROUND_DELAY_MS);
    }

    this.touch();
  }

  totalsFor(userId) {
    return {
      totalGuesses: this.totalGuesses,
      yourGuesses: this.players.get(userId)?.guessCount ?? 0,
    };
  }

  snapshotFor(userId) {
    return {
      instanceId: this.instanceId,
      roundId: this.roundId,
      semanticEnabled: this.semanticEnabled,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        username: player.username,
        avatarUrl: player.avatarUrl,
        guessCount: player.guessCount,
        connected: player.connected,
      })),
      guesses: [...this.guessEntries].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
      totals: this.totalsFor(userId),
    };
  }

  broadcastSnapshot() {
    this.sockets.forEach((ws) => {
      const userId = this.socketToUser.get(ws);
      if (!userId) return;
      this.send(ws, { t: "snapshot", state: this.snapshotFor(userId) });
    });
  }

  broadcast(payload) {
    this.sockets.forEach((ws) => this.send(ws, payload));
  }

  broadcastToUser(userId, payload) {
    this.sockets.forEach((ws) => {
      if (this.socketToUser.get(ws) === userId) this.send(ws, payload);
    });
  }

  send(ws, payload) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  }
}
