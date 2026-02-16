import { cleanText, PROTOCOL_VERSION } from "./protocol.js";

const MAX_GUESSES = 200;
const NEXT_ROUND_DELAY_MS = 8_000;
const ROOM_TTL_MS = 10 * 60_000;
const HINT_COOLDOWN_MS = 20_000;
const SKIP_VOTE_WINDOW_MS = 45_000;
const SKIP_COOLDOWN_MS = 60_000;

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
    this.nextRoundAt = null;
    this.roundEnded = false;
    this.lastActivity = Date.now();
    this.roundGuessCounts = new Map();
    this.roundClosestRanks = new Map();
    this.roundParticipants = new Set();
    this.roundHintedUsers = new Set();
    this.hintCooldownByUser = new Map();
    this.skipVote = null;
    this.skipCooldownUntil = 0;
    this.skipVoteTimer = null;

    this.startNewRound();
  }

  log(event, payload = {}) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), roomId: this.roomId, roundId: this.roundId, event, ...payload }));
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
      if (player) {
        player.connected = false;
        this.broadcast({
          t: "player_left",
          user: {
            id: player.id,
            username: player.username,
            nickname: player.nickname || "",
            avatarUrl: player.avatarUrl,
          },
        });
      }
      this.broadcastRoomState();
    }
    this.socketToUser.delete(ws);
    this.touch();
  }

  handleJoin(ws, msg) {
    const userId = cleanText(msg?.user?.id, 64);
    const username = cleanText(msg?.user?.username, 50);
    const avatarUrl = cleanText(msg?.user?.avatarUrl, 500);
    const nickname = cleanText(msg?.user?.nickname, 80);

    if (!userId || !username) {
      this.send(ws, { t: "error", message: "join requires user id + username" });
      return;
    }

    const existing = this.players.get(userId);
    if (existing) {
      existing.username = username;
      existing.nickname = nickname || existing.nickname || "";
      existing.avatarUrl = avatarUrl || existing.avatarUrl || "";
      existing.connected = true;
    } else {
      this.players.set(userId, {
        id: userId,
        username,
        nickname: nickname || "",
        avatarUrl: avatarUrl || "",
        guessCount: 0,
        connected: true,
      });
    }

    this.statsStore.ensureUser({ id: userId, username, nickname, avatarUrl });

    this.socketToUser.set(ws, userId);
    this.send(ws, { t: "snapshot", state: this.snapshotFor(userId) });
    const player = this.players.get(userId);
    this.broadcast({
      t: "player_joined",
      user: {
        id: player.id,
        username: player.username,
        nickname: player.nickname || "",
        avatarUrl: player.avatarUrl,
      },
    });
    this.broadcastRoomState();
    this.log("join", { userId, username, players: this.players.size });
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
      this.submitGuess(userId, word).catch(() => {
        this.broadcastToUser(userId, { t: "error", message: "Guess unavailable right now." });
      });
      return;
    }

    if (msg.t === "hint_request") {
      this.sendHint(userId).catch(() => {
        this.broadcastToUser(userId, { t: "hint_response", ok: false, message: "Hint unavailable right now." });
      });
      return;
    }

    if (msg.t === "skip_request" || msg.t === "skip_vote") {
      this.handleSkipRequest(userId);
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
    this.roundEnded = false;
    this.nextRoundAt = null;
    this.players.forEach((player) => {
      player.guessCount = 0;
    });
    this.resetSkipVote();

    this.targetWord = this.similarityService.pickTarget();
    const roundData = this.similarityService.buildRound(this.targetWord);
    this.targetWord = roundData.targetWord;
    this.rankMap = roundData.rankMap;
    this.semanticEnabled = roundData.semantic;
    this.evaluateGuess = roundData.evaluateGuess;

    this.broadcast({ t: "new_round", roundId: this.roundId });
    this.broadcastSnapshot();
    this.broadcastRoomState();
    this.log("new_round", { targetWord: this.targetWord, semantic: this.semanticEnabled });
    this.touch();
  }

  finishRoundWithWinner(entry, winnerId, rank = null) {
    if (this.roundEnded) return;
    this.roundEnded = true;

    const participants = [...this.roundParticipants].map((participantId) => {
      const p = this.players.get(participantId);
      return {
        id: participantId,
        username: p?.username || "Unknown",
        avatarUrl: p?.avatarUrl || "",
        nickname: p?.nickname || "",
        guessCount: this.roundGuessCounts.get(participantId) || 0,
      };
    });

    this.statsStore.completeRound({
      roomId: this.roomId,
      participants,
      winnerId,
      closestRanks: this.roundClosestRanks,
    });

    const winnerStats = this.statsStore.statsForUser(winnerId, this.roomId);
    this.nextRoundAt = Date.now() + NEXT_ROUND_DELAY_MS;

    this.broadcast({
      t: "round_won",
      winner: {
        ...entry.user,
        nickname: this.players.get(winnerId)?.nickname || "",
      },
      word: this.targetWord,
      rank: rank ?? entry.rank,
      roundId: this.roundId,
      nextRoundInMs: NEXT_ROUND_DELAY_MS,
      nextRoundAt: this.nextRoundAt,
      winnerStats,
    });

    this.log("round_won", { winnerId, word: this.targetWord, rank: rank ?? entry.rank });

    if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer);
    this.nextRoundTimer = setTimeout(() => {
      this.nextRoundTimer = null;
      this.startNewRound();
    }, NEXT_ROUND_DELAY_MS);
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
    if (this.roundEnded) {
      this.broadcastToUser(userId, { t: "error", message: "Round ended, new round starting…" });
      return;
    }

    const normalized = this.similarityService.normalizeForGuess(rawWord);
    if (!normalized.display) {
      this.broadcastToUser(userId, { t: "error", message: "type a word" });
      return;
    }

    if (!normalized.valid) {
      this.broadcastToUser(userId, { t: "error", message: "Only recognized English words are allowed." });
      this.log("guess_rejected", { userId, input: rawWord, cleaned: normalized.display, canonical: normalized.canonical, reason: normalized.reason });
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
      this.log("guess_rejected", {
        userId,
        input: rawWord,
        cleaned: normalized.display,
        canonical: normalized.canonical,
        reason: result.normalized?.reason || "evaluate_error",
      });
      return;
    }

    const guessKey = (result.resolvedWord || result.canonicalWord || normalized.canonical || "").toLowerCase();
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
        nickname: player.nickname || "",
        avatarUrl: player.avatarUrl,
      },
      word: (result.resolvedWord || result.canonicalWord || normalized.display || rawWord).toLowerCase(),
      result,
    });

    entry.canonical = guessKey;

    this.pushEntry(entry);
    this.rememberGuessAlias(guessKey, entry);
    playerCanonical.add(guessKey);

    this.broadcast({ t: "guess_result", entry, totalGuesses: this.totalGuesses });
    this.broadcastRoomState();

    this.log("guess_submit", {
      userId,
      input: rawWord,
      cleaned: normalized.display,
      canonical: guessKey,
      rank: entry.rank,
      approx: !!entry.approx,
    });

    const normalizedTarget = this.similarityService.normalizeForGuess(this.targetWord).canonical;
    const isWinner = entry.rank === 1 || (guessKey && normalizedTarget && guessKey === normalizedTarget);
    if (isWinner) {
      this.finishRoundWithWinner(entry, userId, 1);
    }

    this.touch();
  }

  connectedPlayerCount() {
    let count = 0;
    this.players.forEach((player) => {
      if (player.connected) count += 1;
    });
    return count;
  }

  skipNeededVotes() {
    return Math.max(2, Math.ceil(this.connectedPlayerCount() * 0.6));
  }

  buildSkipStatus() {
    if (!this.skipVote) return null;
    return {
      t: "skip_status",
      ok: true,
      votes: this.skipVote.voters.size,
      needed: this.skipVote.needed,
      voters: [...this.skipVote.voters],
      expiresAt: this.skipVote.expiresAt,
    };
  }

  resetSkipVote() {
    if (this.skipVoteTimer) {
      clearTimeout(this.skipVoteTimer);
      this.skipVoteTimer = null;
    }
    this.skipVote = null;
  }

  broadcastSkipStatus() {
    const payload = this.buildSkipStatus();
    if (payload) this.broadcast(payload);
  }

  handleSkipRequest(userId) {
    const now = Date.now();
    const player = this.players.get(userId);
    if (!player || !player.connected) {
      this.broadcastToUser(userId, { t: "skip_denied", message: "Only connected players can vote to skip." });
      return;
    }

    if (this.roundEnded) {
      this.broadcastToUser(userId, { t: "skip_denied", message: "Round already ended." });
      return;
    }

    if (this.skipCooldownUntil > now) {
      this.broadcastToUser(userId, {
        t: "skip_denied",
        message: `Skip is on cooldown (${Math.ceil((this.skipCooldownUntil - now) / 1000)}s).`,
      });
      return;
    }

    if (this.skipVote && this.skipVote.roundId !== this.roundId) {
      this.resetSkipVote();
    }

    if (this.skipVote && this.skipVote.expiresAt <= now) {
      this.failSkipVote();
    }

    if (!this.skipVote) {
      this.skipVote = {
        roundId: this.roundId,
        startedAt: now,
        expiresAt: now + SKIP_VOTE_WINDOW_MS,
        voters: new Set(),
        needed: this.skipNeededVotes(),
      };

      this.skipVoteTimer = setTimeout(() => {
        this.skipVoteTimer = null;
        this.failSkipVote();
      }, SKIP_VOTE_WINDOW_MS);
    }

    this.skipVote.needed = this.skipNeededVotes();

    if (!this.skipVote.voters.has(userId)) {
      this.skipVote.voters.add(userId);
    }

    this.broadcastSkipStatus();

    if (this.skipVote.voters.size >= this.skipVote.needed) {
      this.passSkipVote(userId);
    }

    this.touch();
  }

  failSkipVote() {
    if (!this.skipVote) return;

    const votes = this.skipVote.voters.size;
    const needed = this.skipVote.needed;
    this.skipCooldownUntil = Date.now() + SKIP_COOLDOWN_MS;
    this.resetSkipVote();
    this.broadcast({ t: "skip_denied", message: `Skip vote failed (${votes}/${needed}).` });
    this.touch();
  }

  passSkipVote(userId) {
    const byPlayer = this.players.get(userId) || { id: userId, username: "Unknown" };
    this.skipCooldownUntil = Date.now() + SKIP_COOLDOWN_MS;
    this.resetSkipVote();

    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }

    this.broadcast({
      t: "skip_passed",
      by: { id: byPlayer.id, username: byPlayer.username },
      roundId: this.roundId,
    });

    this.log("skip_passed", { by: byPlayer.id });

    this.startNewRound();
  }

  async sendHint(userId) {
    if (this.roundEnded) {
      this.broadcastToUser(userId, { t: "hint_response", ok: false, message: "Round ended, new round starting…" });
      return;
    }

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

    const key = (result.resolvedWord || result.canonicalWord || "").toLowerCase();
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
    this.broadcastToUser(userId, { t: "hint_response", ok: true, roundId: this.roundId });
    this.log("hint", { userId, word: hintEntry.word, canonical: key, rank: hintEntry.rank });
    this.touch();
  }

  async selectHintWord() {
    const guessed = new Set(this.guessEntries.map((entry) => cleanText(entry.word, 120).toLowerCase()));

    if (!this.rankMap || this.rankMap.size < 5) return null;

    const candidates = [];
    this.rankMap.forEach((rank, word) => {
      if (rank <= 1 || rank > 300) return;
      if (guessed.has(word)) return;
      candidates.push({ word, rank });
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => a.rank - b.rank);
    const pool = candidates.slice(0, Math.min(30, candidates.length));
    return pool[Math.floor(Math.random() * pool.length)];
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
      nickname: player.nickname || "",
      avatarUrl: player.avatarUrl,
      guessCount: player.guessCount,
      connected: player.connected,
      stats: this.statsStore.statsForUser(player.id, this.roomId),
    }));
  }

  snapshotFor(userId) {
    return {
      roomId: this.roomId,
      roundId: this.roundId,
      semanticEnabled: this.semanticEnabled,
      roundEnded: this.roundEnded,
      nextRoundAt: this.nextRoundAt,
      players: this.roomPlayers(),
      guesses: [...this.guessEntries].sort((a, b) => a.rank - b.rank || b.ts - a.ts),
      totals: this.totalsFor(userId),
      skipVote: this.skipVote
        ? {
            votes: this.skipVote.voters.size,
            needed: this.skipVote.needed,
            voters: [...this.skipVote.voters],
            expiresAt: this.skipVote.expiresAt,
          }
        : null,
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
