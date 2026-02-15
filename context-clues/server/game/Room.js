import { cleanText, PROTOCOL_VERSION } from "./protocol.js";
import { normalizeGuess } from "../../shared/wordNormalize.js";

const MAX_GUESSES = 200;
const NEXT_ROUND_DELAY_MS = 5_000;
const ROOM_TTL_MS = 10 * 60_000;
const HINT_COOLDOWN_MS = 20_000;

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
    this.guessAliasMap = new Map();
    this.playerGuessCanonical = new Map();
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
    this.roundHintedUsers = new Set();
    this.hintCooldownByUser = new Map();

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
      this.broadcastRoomState();
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
    this.broadcastRoomState();
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

    if (msg.t === "hint_request") {
      this.sendHint(userId).catch(() => {
        this.broadcastToUser(userId, { t: "hint_response", ok: false, message: "Hint unavailable right now." });
      });
      return;
    }

    this.send(ws, { t: "error", message: `Unsupported action: ${msg.t}` });
  }

  startNewRound() {
    this.roundId += 1;
    this.totalGuesses = 0;
    this.guessEntries = [];
    this.guessAliasMap = new Map();
    this.playerGuessCanonical = new Map();
    this.roundParticipants = new Set();
    this.roundGuessCounts = new Map();
    this.roundClosestRanks = new Map();
    this.roundHintedUsers = new Set();
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
    this.broadcastRoomState();
    this.touch();
  }

  existingGuessForWord(wordKey) {
    if (!wordKey) return null;
    return this.guessAliasMap.get(wordKey) || null;
  }

  playerCanonicalSet(userId) {
    if (!this.playerGuessCanonical.has(userId)) {
      this.playerGuessCanonical.set(userId, new Set());
    }
    return this.playerGuessCanonical.get(userId);
  }

  rememberGuessAlias(wordKey, entry) {
    if (!wordKey || !entry) return;
    this.guessAliasMap.set(wordKey, entry);
  }

  buildGuessEntry({ user, word, result, isHint = false }) {
    return {
      id: makeId(isHint ? "hint" : "guess"),
      user,
      word,
      rank: result.rank,
      approx: !!result.approx,
      mode: result.mode,
      similarity: Number(result.similarity.toFixed(5)),
      colorBand: result.colorBand,
      isHint,
      ts: Date.now(),
    };
  }

  pushEntry(entry) {
    this.guessEntries.push(entry);
    if (this.guessEntries.length > MAX_GUESSES) {
      this.guessEntries = this.guessEntries.slice(-MAX_GUESSES);
    }
  }

  async submitGuess(userId, rawWord) {
    const normalized = normalizeGuess(rawWord);
    if (!normalized.display) {
      this.broadcastToUser(userId, { t: "error", message: "type a word" });
      return;
    }

    const player = this.players.get(userId);
    if (!player) return;

    const playerCanonical = this.playerCanonicalSet(userId);
    if (playerCanonical.has(normalized.canonical)) {
      const userDisplay = player.username || "Player";
      this.broadcastToUser(userId, { t: "error", message: `${userDisplay} guessed ${normalized.display} already` });
      return;
    }

    const result = await this.evaluateGuess(normalized.display);
    if (result.error) {
      this.broadcastToUser(userId, { t: "error", message: result.error });
      return;
    }

    const guessKey = result.resolvedWord || result.canonicalWord;

    const existing = this.existingGuessForWord(guessKey);
    if (existing) {
      const guessedBy = existing.user?.username || "Someone";
      const guessedWord = existing.word || guessKey;
      this.broadcastToUser(userId, { t: "error", message: `${guessedBy} guessed ${guessedWord} already` });
      return;
    }

    this.totalGuesses += 1;
    player.guessCount += 1;
    this.roundParticipants.add(userId);
    this.roundGuessCounts.set(userId, (this.roundGuessCounts.get(userId) || 0) + 1);
    const previousBest = this.roundClosestRanks.get(userId);
    if (!previousBest || result.rank < previousBest) this.roundClosestRanks.set(userId, result.rank);

    const entry = this.buildGuessEntry({
      user: {
        id: player.id,
        username: player.username,
        avatarUrl: player.avatarUrl,
      },
      word: (result.resolvedWord || result.canonicalWord || normalized.display || rawWord).toLowerCase(),
      result,
    });

    entry.canonical = guessKey;

    this.pushEntry(entry);
    this.rememberGuessAlias(result.resolvedWord || result.canonicalWord, entry);
    playerCanonical.add(guessKey);

    this.broadcast({ t: "guess_result", entry, totalGuesses: this.totalGuesses });
    this.broadcastRoomState();

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

  async sendHint(userId) {
    const now = Date.now();
    const cooldownUntil = this.hintCooldownByUser.get(userId) || 0;
    if (cooldownUntil > now) {
      this.broadcastToUser(userId, {
        t: "hint_response",
        ok: false,
        message: `Hint cooldown: ${Math.ceil((cooldownUntil - now) / 1000)}s`,
      });
      return;
    }

    if (this.roundHintedUsers.has(userId)) {
      this.broadcastToUser(userId, {
        t: "hint_response",
        ok: false,
        message: "You already used your hint for this round.",
      });
      return;
    }

    const hinted = await this.selectHintWord();
    if (!hinted) {
      this.broadcastToUser(userId, {
        t: "hint_response",
        ok: false,
        message: "No hint available right now. Try a few guesses first.",
      });
      return;
    }

    const result = await this.evaluateGuess(hinted.word);
    if (result.error) {
      this.broadcastToUser(userId, {
        t: "hint_response",
        ok: false,
        message: "No hint available right now. Try a few guesses first.",
      });
      return;
    }

    const key = result.resolvedWord || result.canonicalWord;
    const already = this.existingGuessForWord(key);
    if (already) {
      this.broadcastToUser(userId, {
        t: "hint_response",
        ok: false,
        message: "Hint unavailable right now. Try a new guess.",
      });
      return;
    }

    this.roundHintedUsers.add(userId);
    this.hintCooldownByUser.set(userId, now + HINT_COOLDOWN_MS);

    this.totalGuesses += 1;
    const hintEntry = this.buildGuessEntry({
      user: { id: "hint", username: "?", avatarUrl: "" },
      word: (result.resolvedWord || hinted.word || "").toLowerCase(),
      result,
      isHint: true,
    });
    hintEntry.canonical = key;

    this.pushEntry(hintEntry);
    this.rememberGuessAlias(key, hintEntry);

    this.broadcast({ t: "guess_result", entry: hintEntry, totalGuesses: this.totalGuesses });
    this.broadcastRoomState();
    this.broadcastToUser(userId, { t: "hint_response", ok: true, roundId: this.roundId });
  }

  async selectHintWord() {
    const guessed = new Set(this.guessEntries.map((entry) => cleanText(entry.word, 120).toLowerCase()));

    if (this.rankMap && this.rankMap.size >= 5) {
      const candidates = [];
      this.rankMap.forEach((rank, word) => {
        if (rank <= 1 || rank > 300) return;
        if (guessed.has(word)) return;
        candidates.push({ word, rank });
      });

      if (candidates.length) {
        candidates.sort((a, b) => a.rank - b.rank);
        const pool = candidates.slice(0, Math.min(30, candidates.length));
        return pool[Math.floor(Math.random() * pool.length)];
      }
    }

    const vocabulary = this.similarityService?.vocabulary || [];
    if (!vocabulary.length) return null;

    const sampled = [];
    const targetSampleSize = Math.min(600, vocabulary.length);
    const seen = new Set();

    while (sampled.length < targetSampleSize && seen.size < vocabulary.length) {
      const candidate = vocabulary[Math.floor(Math.random() * vocabulary.length)];
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (candidate === this.targetWord || guessed.has(candidate)) continue;
      sampled.push(candidate);
    }

    if (!sampled.length) return null;

    const ranked = [];
    const maxHintRank = this.semanticEnabled ? 300 : Number.POSITIVE_INFINITY;

    for (const word of sampled) {
      const result = await this.evaluateGuess(word);
      if (result?.error || !Number.isFinite(result?.rank) || result.rank <= 1 || result.rank > maxHintRank) continue;
      ranked.push({ word, rank: result.rank });
    }

    if (!ranked.length) return null;

    ranked.sort((a, b) => a.rank - b.rank);
    const pool = ranked.slice(0, Math.min(20, ranked.length));
    return pool[Math.floor(Math.random() * pool.length)];
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

  roomPlayers() {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      username: player.username,
      avatarUrl: player.avatarUrl,
      connected: player.connected,
      guessCount: player.guessCount,
    }));
  }

  snapshotFor(userId) {
    return {
      roomId: this.roomId,
      roundId: this.roundId,
      semanticEnabled: this.semanticEnabled,
      players: this.roomPlayers(),
      guesses: [...this.guessEntries].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
      totals: this.totalsFor(userId),
    };
  }

  broadcastRoomState() {
    this.broadcast({ t: "room_state", roomId: this.roomId, roundId: this.roundId, players: this.roomPlayers() });
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
