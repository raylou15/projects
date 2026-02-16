import crypto from "crypto";
import { WebSocketServer } from "ws";
import mongoose from "mongoose";

const BASE_POINTS = 10;
const QUESTION_MS = 25_000;
const RESULTS_MS = 8_000;
const AUTO_HINT_RATIO = 0.75;
const NEXT_REQUEST_COOLDOWN_MS = 2_000;

let dbConnectPromise = null;
let modelBundle = null;

const roomHub = new Map();

function getConfigDatabaseUrl() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const maybe = globalThis?.config?.DatabaseURL;
    return typeof maybe === "string" ? maybe : "";
  } catch {
    return "";
  }
}

async function ensureDbConnected(logger = console) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (dbConnectPromise) return dbConnectPromise;
  const uri = process.env.DATABASE_URL || getConfigDatabaseUrl();
  if (!uri) {
    throw new Error("Missing DATABASE_URL (or config.DatabaseURL fallback)");
  }

  dbConnectPromise = mongoose.connect(uri, {}).then((conn) => {
    logger.info?.("[trivia] MongoDB connected.");
    return conn;
  }).catch((error) => {
    dbConnectPromise = null;
    throw error;
  });

  return dbConnectPromise;
}

function getModels() {
  if (modelBundle) return modelBundle;

  const scoreSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    riddlePoints: { type: Number, default: 0 },
    triviaPoints: { type: Number, default: 0 },
    triviaLongestStreak: { type: Number, default: 0 },
  });

  const seasonScoreSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    riddlePoints: { type: Number, default: 0 },
    triviaPoints: { type: Number, default: 0 },
    triviaLongestStreak: { type: Number, default: 0 },
  }, { _id: false });

  const winnerSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    riddlePoints: { type: Number, required: true },
    triviaPoints: { type: Number, required: true },
    totalPoints: { type: Number, required: true },
    rank: { type: Number, required: true },
  }, { _id: false });

  const seasonSchema = new mongoose.Schema({
    seasonNumber: { type: Number, required: true, unique: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    seasonScores: { type: [seasonScoreSchema], default: [] },
    winners: { type: [winnerSchema], default: [] },
  });

  const questionSchema = new mongoose.Schema({
    seasonNumber: { type: Number, required: true, index: true },
    questionHash: { type: String, required: true, index: true },
    correctUserIds: { type: [String], default: [] },
  }, { timestamps: true });
  questionSchema.index({ seasonNumber: 1, questionHash: 1 }, { unique: true });

  modelBundle = {
    RiddleTriviaScore: mongoose.models.RiddleTriviaScore || mongoose.model("RiddleTriviaScore", scoreSchema),
    RiddleTriviaSeason: mongoose.models.RiddleTriviaSeason || mongoose.model("RiddleTriviaSeason", seasonSchema),
    RiddleTriviaQuestion: mongoose.models.RiddleTriviaQuestion || mongoose.model("RiddleTriviaQuestion", questionSchema),
  };

  return modelBundle;
}

function isSameMonth(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

async function ensureActiveSeason(logger = console) {
  await ensureDbConnected(logger);
  const { RiddleTriviaSeason } = getModels();
  const now = new Date();

  let active = await RiddleTriviaSeason.findOne({ isActive: true }).sort({ seasonNumber: -1 }).lean(false);
  if (!active) {
    const latest = await RiddleTriviaSeason.findOne({}).sort({ seasonNumber: -1 }).lean();
    const seasonNumber = latest ? latest.seasonNumber + 1 : 1;
    active = await RiddleTriviaSeason.create({ seasonNumber, startAt: now, isActive: true });
    return active;
  }

  if (isSameMonth(new Date(active.startAt), now)) return active;

  const winners = [...(active.seasonScores || [])]
    .map((row) => ({
      userId: row.userId,
      riddlePoints: row.riddlePoints || 0,
      triviaPoints: row.triviaPoints || 0,
      totalPoints: (row.riddlePoints || 0) + (row.triviaPoints || 0),
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints || b.triviaPoints - a.triviaPoints)
    .slice(0, 3)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  active.endAt = now;
  active.isActive = false;
  active.winners = winners;
  await active.save();

  const latest = await RiddleTriviaSeason.findOne({}).sort({ seasonNumber: -1 }).lean();
  const next = await RiddleTriviaSeason.create({ seasonNumber: (latest?.seasonNumber || 0) + 1, startAt: now, isActive: true });
  return next;
}

function decodeHtmlEntities(text = "") {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&eacute;", "é");
}

function normalizeTriviaText(input = "") {
  const decoded = decodeHtmlEntities(String(input));
  return decoded
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9.\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNumericValue(value) {
  return /^[-+]?\d+(\.\d+)?$/.test(value);
}

function createQuestionHash(question) {
  const material = `${question.provider}|${normalizeTriviaText(question.questionText)}|${normalizeTriviaText(question.answers[question.correctIndex])}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}

async function fetchOpenTdb() {
  const res = await fetch("https://opentdb.com/api.php?amount=1&type=multiple", { method: "GET" });
  if (!res.ok) throw new Error(`OpenTDB HTTP ${res.status}`);
  const json = await res.json();
  if (json.response_code !== 0 || !json.results?.length) {
    throw new Error(`OpenTDB response_code ${json.response_code}`);
  }
  const q = json.results[0];
  const answers = [...q.incorrect_answers.map((a) => decodeHtmlEntities(a)), decodeHtmlEntities(q.correct_answer)];
  for (let i = answers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }
  const correctIndex = answers.findIndex((a) => normalizeTriviaText(a) === normalizeTriviaText(q.correct_answer));
  return {
    provider: "opentdb",
    category: decodeHtmlEntities(q.category),
    difficulty: decodeHtmlEntities(q.difficulty),
    questionText: decodeHtmlEntities(q.question),
    answers,
    correctIndex,
    attribution: null,
  };
}

async function fetchTriviaApi() {
  const res = await fetch("https://the-trivia-api.com/v2/questions?limit=1", { method: "GET" });
  if (!res.ok) throw new Error(`TheTriviaAPI HTTP ${res.status}`);
  const json = await res.json();
  const q = Array.isArray(json) ? json[0] : json?.questions?.[0];
  if (!q) throw new Error("Empty TheTriviaAPI payload");
  const answers = [...(q.incorrectAnswers || []), q.correctAnswer].map((v) => decodeHtmlEntities(v));
  for (let i = answers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }
  const correctIndex = answers.findIndex((a) => normalizeTriviaText(a) === normalizeTriviaText(q.correctAnswer));
  return {
    provider: "the-trivia-api",
    category: decodeHtmlEntities(q.category || "General"),
    difficulty: decodeHtmlEntities((q.difficulty || "medium").toLowerCase()),
    questionText: decodeHtmlEntities(q.question?.text || q.question || ""),
    answers,
    correctIndex,
    attribution: "Questions powered by The Trivia API",
  };
}

async function fetchQuestionWithFallback(logger = console) {
  for (let i = 0; i < 3; i += 1) {
    try {
      return await fetchOpenTdb();
    } catch (error) {
      logger.warn?.(`[trivia] OpenTDB attempt ${i + 1} failed: ${error.message}`);
    }
  }

  for (let i = 0; i < 3; i += 1) {
    try {
      return await fetchTriviaApi();
    } catch (error) {
      logger.warn?.(`[trivia] The Trivia API attempt ${i + 1} failed: ${error.message}`);
    }
  }

  throw new Error("All trivia providers failed");
}

function stripSocketPlayer(player) {
  return {
    userId: player.userId,
    displayName: player.displayName,
    avatarUrl: player.avatarUrl,
    points: player.points,
    currentStreak: player.currentStreak,
    connected: player.connected,
  };
}

function sanitizeQuestionPublic(room) {
  if (!room.question) return null;
  return {
    category: room.question.category,
    difficulty: room.question.difficulty,
    questionText: room.question.questionText,
    answers: room.question.answers,
    startedAt: room.startedAt,
    deadlineAt: room.deadlineAt,
    attribution: room.question.attribution,
    answerCount: Object.keys(room.answersByUser).length,
    pointMultiplier: room.pointMultiplier,
  };
}

function resultPublic(room) {
  return {
    correctIndex: room.question?.correctIndex ?? null,
    correctAnswer: room.question?.answers?.[room.question?.correctIndex] || null,
    winner: room.roundWinner,
    answers: room.roundResults,
    nextRoundAt: room.nextRoundAt,
  };
}

function buildState(room) {
  return {
    type: "state",
    seq: ++room.seq,
    roomKey: room.roomKey,
    phase: room.phase,
    players: [...room.players.values()].map(stripSocketPlayer),
    questionPublic: sanitizeQuestionPublic(room),
    timer: {
      now: Date.now(),
      deadlineAt: room.phase === "question" ? room.deadlineAt : room.nextRoundAt,
      questionMs: QUESTION_MS,
      resultsMs: RESULTS_MS,
    },
    hintPublic: room.hintPublic,
    skipVotes: { votes: [...room.skipVotes], threshold: room.skipThreshold },
    resultsPublic: room.phase === "results" ? resultPublic(room) : null,
  };
}

function send(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch {
    // ignore per socket
  }
}

function broadcast(room) {
  const payload = JSON.stringify(buildState(room));
  room.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

function getOrCreateRoom(roomKey) {
  let room = roomHub.get(roomKey);
  if (room) return room;
  room = {
    roomKey,
    seq: 0,
    phase: "lobby",
    players: new Map(),
    clients: new Set(),
    playerSockets: new Map(),
    question: null,
    startedAt: null,
    deadlineAt: null,
    nextRoundAt: null,
    pointMultiplier: 1,
    hintPublic: { autoHintActive: false, autoHintText: null },
    skipVotes: new Set(),
    skipThreshold: 1,
    answersByUser: {},
    roundResults: [],
    roundWinner: null,
    timers: { endQuestion: null, autoHint: null, nextRound: null },
    nextRequestAt: 0,
  };
  roomHub.set(roomKey, room);
  return room;
}

function clearRoomTimers(room) {
  Object.values(room.timers).forEach((timer) => {
    if (timer) clearTimeout(timer);
  });
  room.timers = { endQuestion: null, autoHint: null, nextRound: null };
}

function updateSkipThreshold(room) {
  const activePlayers = [...room.players.values()].filter((p) => p.connected).length;
  room.skipThreshold = Math.max(1, Math.min(3, activePlayers || room.players.size || 1));
}

function validateInbound(msg) {
  if (!msg || typeof msg !== "object") return "Invalid message";
  if (msg.v !== 1) return "Unsupported version";
  if (typeof msg.type !== "string") return "Missing type";
  return null;
}

async function applyHintPenalty(userId, logger) {
  await ensureDbConnected(logger);
  const season = await ensureActiveSeason(logger);
  const { RiddleTriviaScore, RiddleTriviaSeason } = getModels();

  await RiddleTriviaScore.updateOne(
    { userId },
    [
      { $set: { triviaPoints: { $max: [0, { $subtract: ["$triviaPoints", 1] }] } } },
    ],
    { upsert: true, setDefaultsOnInsert: true },
  );

  const seasonDoc = await RiddleTriviaSeason.findOne({ _id: season._id });
  const row = seasonDoc.seasonScores.find((s) => s.userId === userId);
  if (!row) {
    seasonDoc.seasonScores.push({ userId, triviaPoints: 0, riddlePoints: 0, triviaLongestStreak: 0 });
  } else {
    row.triviaPoints = Math.max(0, (row.triviaPoints || 0) - 1);
  }
  await seasonDoc.save();
}

async function awardCorrectAnswer({ room, player, elapsedMs, logger }) {
  await ensureDbConnected(logger);
  const season = await ensureActiveSeason(logger);
  const { RiddleTriviaScore, RiddleTriviaSeason, RiddleTriviaQuestion } = getModels();

  const hash = createQuestionHash(room.question);
  const dedupe = await RiddleTriviaQuestion.updateOne(
    { seasonNumber: season.seasonNumber, questionHash: hash },
    { $addToSet: { correctUserIds: player.userId } },
    { upsert: true },
  );
  const newlyAdded = Boolean(dedupe.upsertedId) || dedupe.modifiedCount === 1;
  if (!newlyAdded) return { awarded: 0, deduped: true };

  const pointsAward = Math.max(1, Math.round(BASE_POINTS * room.pointMultiplier));
  player.points += pointsAward;
  player.currentStreak += 1;
  const newLongest = Math.max(player.longestStreak || 0, player.currentStreak);
  player.longestStreak = newLongest;

  await RiddleTriviaScore.findOneAndUpdate(
    { userId: player.userId },
    {
      $inc: { triviaPoints: pointsAward },
      $max: { triviaLongestStreak: newLongest },
      $setOnInsert: { riddlePoints: 0 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await RiddleTriviaSeason.updateOne(
    { _id: season._id, "seasonScores.userId": { $ne: player.userId } },
    { $push: { seasonScores: { userId: player.userId, riddlePoints: 0, triviaPoints: 0, triviaLongestStreak: 0 } } },
  );

  await RiddleTriviaSeason.updateOne(
    { _id: season._id, "seasonScores.userId": player.userId },
    {
      $inc: { "seasonScores.$.triviaPoints": pointsAward },
      $max: { "seasonScores.$.triviaLongestStreak": newLongest },
    },
  );

  return { awarded: pointsAward, elapsedMs, deduped: false };
}

function endRound(room, reason = "timeout") {
  if (room.phase !== "question") return;
  clearTimeout(room.timers.endQuestion);
  clearTimeout(room.timers.autoHint);

  room.phase = "results";
  room.roundResults = Object.values(room.answersByUser).sort((a, b) => {
    if (a.isCorrect !== b.isCorrect) return Number(b.isCorrect) - Number(a.isCorrect);
    return (a.answeredAt || 0) - (b.answeredAt || 0);
  });
  room.roundWinner = room.roundResults.find((row) => row.isCorrect) || null;
  room.nextRoundAt = Date.now() + RESULTS_MS;
  broadcast(room);

  room.timers.nextRound = setTimeout(() => {
    startRound(room).catch(() => {
      room.phase = "lobby";
      broadcast(room);
    });
  }, RESULTS_MS);
}

async function startRound(room, logger = console) {
  clearRoomTimers(room);
  room.skipVotes.clear();
  updateSkipThreshold(room);
  room.phase = "question";
  room.hintPublic = { autoHintActive: false, autoHintText: null };
  room.answersByUser = {};
  room.roundResults = [];
  room.roundWinner = null;
  room.pointMultiplier = 1;

  const question = await fetchQuestionWithFallback(logger);
  room.question = question;
  room.startedAt = Date.now();
  room.deadlineAt = room.startedAt + QUESTION_MS;

  room.timers.autoHint = setTimeout(() => {
    room.pointMultiplier = 0.5;
    const correct = room.question.answers[room.question.correctIndex];
    const wrongIndices = room.question.answers
      .map((_, idx) => idx)
      .filter((idx) => idx !== room.question.correctIndex);
    const removedIndex = wrongIndices[Math.floor(Math.random() * wrongIndices.length)];
    room.hintPublic = { autoHintActive: true, autoHintText: `One wrong answer removed: ${room.question.answers[removedIndex]}` };
    broadcast(room);
  }, Math.floor(QUESTION_MS * AUTO_HINT_RATIO));

  room.timers.endQuestion = setTimeout(() => endRound(room, "timeout"), QUESTION_MS);
  broadcast(room);
}

function maybeStartFromLobby(room, logger = console) {
  if (room.phase !== "lobby") return;
  const active = [...room.players.values()].filter((p) => p.connected).length;
  if (active < 1) return;
  startRound(room, logger).catch((error) => {
    logger.error?.("[trivia] failed to start round", error);
  });
}

function joinRoom({ ws, roomKey, user }) {
  const room = getOrCreateRoom(roomKey);
  room.clients.add(ws);
  room.playerSockets.set(ws, user.userId);

  const existing = room.players.get(user.userId);
  if (existing) {
    existing.connected = true;
    existing.displayName = user.displayName;
    existing.avatarUrl = user.avatarUrl;
  } else {
    room.players.set(user.userId, {
      userId: user.userId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      points: 0,
      currentStreak: 0,
      longestStreak: 0,
      connected: true,
      personalHintUsed: false,
    });
  }

  updateSkipThreshold(room);
  broadcast(room);
  maybeStartFromLobby(room);
  return room;
}

function handleClose(ws) {
  roomHub.forEach((room) => {
    if (!room.clients.has(ws)) return;
    room.clients.delete(ws);
    const userId = room.playerSockets.get(ws);
    room.playerSockets.delete(ws);
    if (userId && room.players.has(userId)) {
      room.players.get(userId).connected = false;
    }
    updateSkipThreshold(room);
    broadcast(room);
  });
}

async function handleAction(room, ws, msg, logger = console) {
  const userId = room.playerSockets.get(ws);
  const player = userId ? room.players.get(userId) : null;
  if (!player) {
    send(ws, { type: "error", message: "Join first" });
    return;
  }

  if (msg.type === "answer") {
    if (room.phase !== "question" || !room.question) return;
    if (room.answersByUser[player.userId]) return;
    const answerIndex = Number(msg.answerIndex);
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= room.question.answers.length) {
      send(ws, { type: "error", message: "Invalid answer index" });
      return;
    }

    const answerText = room.question.answers[answerIndex];
    const normalizedCorrect = normalizeTriviaText(room.question.answers[room.question.correctIndex]);
    const normalizedGuess = normalizeTriviaText(answerText);
    let isCorrect;
    if (isNumericValue(normalizedCorrect)) {
      isCorrect = isNumericValue(normalizedGuess) && Number(normalizedGuess) === Number(normalizedCorrect);
    } else {
      isCorrect = normalizedGuess === normalizedCorrect;
    }

    const answeredAt = Date.now();
    const elapsedMs = answeredAt - room.startedAt;
    const row = {
      userId: player.userId,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
      answerIndex,
      answerText,
      answeredAt,
      isCorrect,
      pointsAwarded: 0,
    };

    if (isCorrect) {
      try {
        const award = await awardCorrectAnswer({ room, player, elapsedMs, logger });
        row.pointsAwarded = award.awarded;
      } catch (error) {
        logger.warn?.("[trivia] failed awarding points", error);
      }
    } else {
      player.currentStreak = 0;
    }

    room.answersByUser[player.userId] = row;

    const activePlayers = [...room.players.values()].filter((p) => p.connected).length;
    if (Object.keys(room.answersByUser).length >= Math.max(1, activePlayers)) {
      endRound(room, "all_answered");
      return;
    }

    broadcast(room);
    return;
  }

  if (msg.type === "hint") {
    if (room.phase !== "question" || player.personalHintUsed) return;
    player.personalHintUsed = true;
    try {
      await applyHintPenalty(player.userId, logger);
      player.points = Math.max(0, player.points - 1);
    } catch (error) {
      logger.warn?.("[trivia] hint penalty failed", error);
    }

    const wrong = room.question.answers
      .map((ans, idx) => ({ ans, idx }))
      .filter((item) => item.idx !== room.question.correctIndex);
    const removed = wrong[Math.floor(Math.random() * wrong.length)]?.ans;
    send(ws, { type: "hint_result", removedAnswer: removed, pointsPenalty: 1 });
    broadcast(room);
    return;
  }

  if (msg.type === "skip") {
    if (room.phase !== "question") return;
    room.skipVotes.add(player.userId);
    updateSkipThreshold(room);
    if (room.skipVotes.size >= room.skipThreshold) {
      endRound(room, "skip_vote");
      return;
    }
    broadcast(room);
    return;
  }

  if (msg.type === "chat" && String(msg.text || "").trim().toLowerCase() === "skip") {
    return handleAction(room, ws, { v: 1, type: "skip" }, logger);
  }

  if (msg.type === "next") {
    if (room.phase !== "results") return;
    const now = Date.now();
    if (now < room.nextRequestAt) return;
    room.nextRequestAt = now + NEXT_REQUEST_COOLDOWN_MS;
    clearTimeout(room.timers.nextRound);
    startRound(room, logger).catch((error) => {
      logger.warn?.("[trivia] next request failed", error);
    });
    return;
  }
}

function parseLeaderboardScope(scope) {
  return ["global", "season", "room"].includes(scope) ? scope : "global";
}

export function registerGameModule({ slug, app, server, logger, registerUpgradeHandler }) {
  const triviaWss = new WebSocketServer({ noServer: true });

  registerUpgradeHandler((request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== "/ws/trivia") return false;
    triviaWss.handleUpgrade(request, socket, head, (ws) => {
      triviaWss.emit("connection", ws, request);
    });
    return true;
  });

  triviaWss.on("connection", (ws) => {
    let room = null;

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }
      const err = validateInbound(msg);
      if (err) {
        send(ws, { type: "error", message: err });
        return;
      }

      if (msg.type === "join") {
        const roomKey = String(msg.roomKey || "").slice(0, 160);
        const userId = String(msg.user?.userId || "").slice(0, 120);
        const displayName = String(msg.user?.displayName || "Guest").slice(0, 80);
        const avatarUrl = String(msg.user?.avatarUrl || "").slice(0, 300);
        if (!roomKey || !userId) {
          send(ws, { type: "error", message: "roomKey and user.userId required" });
          return;
        }
        room = joinRoom({ ws, roomKey, user: { userId, displayName, avatarUrl } });
        return;
      }

      if (!room) {
        send(ws, { type: "error", message: "Join first" });
        return;
      }

      try {
        await handleAction(room, ws, msg, logger);
      } catch (error) {
        logger.warn?.("[trivia] action failed", error);
        send(ws, { type: "error", message: "Action failed" });
      }
    });

    ws.on("close", () => handleClose(ws));
  });

  app.get("/api/trivia/health", (_req, res) => {
    res.send({ ok: true });
  });

  app.get("/api/trivia/leaderboard", async (req, res) => {
    const scope = parseLeaderboardScope(String(req.query.scope || "global"));
    try {
      if (scope === "room") {
        const roomKey = String(req.query.roomKey || "");
        const room = roomHub.get(roomKey);
        const rows = room ? [...room.players.values()].map(stripSocketPlayer).sort((a, b) => b.points - a.points) : [];
        return res.send({ ok: true, scope, rows });
      }

      await ensureDbConnected(logger);
      const { RiddleTriviaScore } = getModels();

      if (scope === "global") {
        const rows = await RiddleTriviaScore.find({}).sort({ triviaPoints: -1 }).limit(25).lean();
        return res.send({ ok: true, scope, rows });
      }

      const season = await ensureActiveSeason(logger);
      const rows = [...(season.seasonScores || [])].sort((a, b) => (b.triviaPoints || 0) - (a.triviaPoints || 0)).slice(0, 25);
      return res.send({ ok: true, scope, seasonNumber: season.seasonNumber, rows });
    } catch (error) {
      return res.status(500).send({ ok: false, error: error.message });
    }
  });

  app.get("/api/trivia/me", async (req, res) => {
    const userId = String(req.query.userId || "");
    const roomKey = String(req.query.roomKey || "");
    if (!userId) {
      return res.status(400).send({ ok: false, error: "userId is required" });
    }
    try {
      await ensureDbConnected(logger);
      const { RiddleTriviaScore } = getModels();
      const season = await ensureActiveSeason(logger);
      const global = await RiddleTriviaScore.findOne({ userId }).lean();
      const seasonRow = (season.seasonScores || []).find((row) => row.userId === userId) || null;
      const room = roomHub.get(roomKey);
      const roomPlayer = room?.players.get(userId);
      return res.send({
        ok: true,
        userId,
        global: global || { userId, triviaPoints: 0, triviaLongestStreak: 0, riddlePoints: 0 },
        season: seasonRow || { userId, triviaPoints: 0, triviaLongestStreak: 0, riddlePoints: 0 },
        room: roomPlayer ? { points: roomPlayer.points, currentStreak: roomPlayer.currentStreak } : null,
      });
    } catch (error) {
      return res.status(500).send({ ok: false, error: error.message });
    }
  });

  app.get(`/api/games/${slug}/health`, (_req, res) => {
    res.send({ ok: true, slug, status: "ready" });
  });

  logger.info?.(`[games] '${slug}' module registered.`);
}

export { ensureActiveSeason };
