import { cleanText, PROTOCOL_VERSION } from "./protocol.js";

const MAX_GUESSES = 200;
const NEXT_ROUND_DELAY_MS = 5_000;
const ROOM_TTL_MS = 10 * 60_000;

function makeId(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export class Room {
  constructor(roomId, similarityService, statsStore) {
    this.roomId = roomId;
    this.similarityService = similarityService;
    this.statsStore = statsStore;
    this.players = new Map();
    this.sockets = new Set();
    this.socketToUser = new Map();
    this.totalGuesses = 0;
    this.guessEntries = [];
    this.roundId = 0;
    this.targetWord = "";
    this.rankMap = new Map();
    this.evaluateGuess = null;
    this.semanticEnabled = false;
    this.nextRoundTimer = null;
    this.lastActivity = Date.now();
    this.roundGuessCounts = new Map();
    this.roundClosestRanks = new Map();
    this.roundParticipants = new Set();

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

    this.statsStore.ensureUser({ id: userId, username, avatarUrl });

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

    if (msg.t === "stats") {
      this.sendStats(userId);
      return;
    }

    this.send(ws, { t: "error", message: `Unsupported action: ${msg.t}` });
  }

  startNewRound() {
    this.roundId += 1;
    this.totalGuesses = 0;
    this.guessEntries = [];
    this.roundParticipants = new Set();
    this.roundGuessCounts = new Map();
    this.roundClosestRanks = new Map();
    this.players.forEach((player) => {
      player.guessCount = 0;
    });

    this.targetWord = this.similarityService.pickTarget();
    const roundData = this.similarityService.buildRound(this.targetWord);
    this.targetWord = roundData.targetWord;
    this.rankMap = roundData.rankMap;
    this.semanticEnabled = roundData.semantic;
    this.evaluateGuess = roundData.evaluateGuess;

    this.broadcast({ t: "new_round", roundId: this.roundId });
    this.broadcastSnapshot();
    this.touch();
  }

  async submitGuess(userId, rawWord) {
    if (!rawWord) {
      this.broadcastToUser(userId, { t: "error", message: "type a word" });
      return;
    }

    const player = this.players.get(userId);
    if (!player) return;

    const result = await this.evaluateGuess(rawWord);
    if (result.error) {
      this.broadcastToUser(userId, { t: "error", message: result.error });
      return;
    }

    this.totalGuesses += 1;
    player.guessCount += 1;
    this.roundParticipants.add(userId);
    this.roundGuessCounts.set(userId, (this.roundGuessCounts.get(userId) || 0) + 1);
    const previousBest = this.roundClosestRanks.get(userId);
    if (!previousBest || result.rank < previousBest) this.roundClosestRanks.set(userId, result.rank);

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
      mode: result.mode,
      similarity: Number(result.similarity.toFixed(5)),
      colorBand: result.colorBand,
      ts: Date.now(),
    };

    this.guessEntries.push(entry);
    if (this.guessEntries.length > MAX_GUESSES) {
      this.guessEntries = this.guessEntries.slice(-MAX_GUESSES);
    }

    this.broadcast({ t: "guess_result", entry, totalGuesses: this.totalGuesses });

    if (entry.rank === 1) {
      const participants = [...this.roundParticipants].map((participantId) => {
        const p = this.players.get(participantId);
        return {
          id: participantId,
          username: p?.username || "Unknown",
          avatarUrl: p?.avatarUrl || "",
          guessCount: this.roundGuessCounts.get(participantId) || 0,
        };
      });

      const pointsAwarded = this.statsStore.completeRound({
        roomId: this.roomId,
        participants,
        winnerId: userId,
        winnerGuesses: this.roundGuessCounts.get(userId) || 0,
        closestRanks: this.roundClosestRanks,
      });

      this.broadcast({
        t: "round_won",
        winner: entry.user,
        word: this.targetWord,
        pointsAwarded,
        nextRoundInMs: NEXT_ROUND_DELAY_MS,
      });

      this.sendStats(userId);

      if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = setTimeout(() => {
        this.nextRoundTimer = null;
        this.startNewRound();
      }, NEXT_ROUND_DELAY_MS);
    }

    this.touch();
  }

  sendStats(userId) {
    this.broadcastToUser(userId, {
      t: "stats_view",
      you: this.statsStore.statsForUser(userId, this.roomId),
      leaderboard: this.statsStore.leaderboard(this.roomId, 10),
    });
  }

  totalsFor(userId) {
    return {
      totalGuesses: this.totalGuesses,
      yourGuesses: this.players.get(userId)?.guessCount ?? 0,
    };
  }

  snapshotFor(userId) {
    return {
      roomId: this.roomId,
      roundId: this.roundId,
      semanticEnabled: this.semanticEnabled,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        username: player.username,
        avatarUrl: player.avatarUrl,
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
