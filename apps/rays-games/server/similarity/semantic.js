import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { colorBandForRank } from "./text.js";
import { buildVocabulary, FOREIGN_STOPWORDS } from "../game/vocab.js";
import { FallbackRanker } from "./fallback.js";
import { chooseRepresentative } from "../util/aliasRepresentative.js";
import { createWordNormalizer } from "../../shared/wordNormalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const COMMON_ALLOWLIST_PATH = path.resolve(serverRoot, "data/common-allowlist.txt");
const SECRET_HISTORY_SIZE = 50;

const INTRINSIC_S_WORDS = new Set([
  "analysis",
  "bass",
  "bias",
  "business",
  "chess",
  "class",
  "glass",
  "grass",
  "news",
  "series",
  "species",
  "status",
  "thesis",
]);

const UNCOMMON_PATTERNS = [
  /[qxzj]{2}/,
  /[aeiou]{4}/,
  /[^aeiou]{5}/,
  /(.)\1\1/,
];

const IRREGULAR_ALIASES = new Map([
  ["men", "man"],
  ["children", "child"],
  ["mice", "mouse"],
  ["geese", "goose"],
  ["ran", "run"],
  ["running", "run"],
  ["went", "go"],
]);

function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export class SemanticRankService {
  constructor({
    vocabPath = path.resolve(serverRoot, "data/vocab-common.txt"),
    embeddingsPath = path.resolve(serverRoot, "data/embeddings.trimmed.json"),
    commonAllowlistPath = COMMON_ALLOWLIST_PATH,
  } = {}) {
    this.vocabPath = vocabPath;
    this.embeddingsPath = embeddingsPath;
    this.commonAllowlistPath = commonAllowlistPath;
    this.vocabulary = [];
    this.fullVocabulary = [];
    this.vocabularySet = new Set();
    this.aliasMap = new Map();
    this.vectors = new Map();
    this.fallback = null;
    this.semanticEnabled = false;
    this.wordNormalizer = createWordNormalizer();
    this.commonAllowlist = new Set();
    this.secretHistoryByRoom = new Map();
    this.secretSelectionCounterByRoom = new Map();
    this.lastSecretSelectionStats = {
      totalVocabSize: 0,
      filteredCandidateSize: 0,
      allowlistPresent: false,
      allowlistIntersectionSize: 0,
      exampleCandidates: [],
    };
  }

  static readWordList(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean)
      .filter((line) => /^[a-z]+$/.test(line));
  }

  getSelectionVocabulary() {
    return this.vocabulary.length ? this.vocabulary : this.fullVocabulary;
  }

  hasMorphologicalSuffix(word) {
    if (!word || word.length < 4) return false;
    if (word.endsWith("ing") || word.endsWith("ed") || word.endsWith("ies") || word.endsWith("es")) return true;
    if (word.endsWith("s") && word.length > 4 && !INTRINSIC_S_WORDS.has(word)) return true;
    return false;
  }

  hasGarbagePattern(word) {
    return UNCOMMON_PATTERNS.some((pattern) => pattern.test(word));
  }

  isGuessableSecretCandidate(word, { maxLength = 12 } = {}) {
    if (!word || typeof word !== "string") return false;
    if (!/^[a-z]+$/.test(word)) return false;
    if (word.includes("-") || word.includes("'")) return false;
    if (word.length < 4 || word.length > maxLength) return false;
    if (FOREIGN_STOPWORDS.has(word)) return false;
    if (this.hasMorphologicalSuffix(word)) return false;

    const normalized = this.wordNormalizer.normalizeGuess(word);
    if (!normalized.canonical || normalized.canonical !== word) return false;
    if (this.hasGarbagePattern(word)) return false;

    return true;
  }

  scoreSecretCandidate(word) {
    let score = 0;
    if (word.length <= 8) score += 20 - (word.length - 4) * 2;
    else score -= (word.length - 8) * 2;

    const rareLetters = (word.match(/[qxzj]/g) || []).length;
    score -= rareLetters * 3;

    if (this.commonAllowlist.has(word)) score += 35;
    if (word.includes("k") && word.length > 9) score -= 1;
    return score;
  }

  deterministicIndex(key, length) {
    if (!length) return 0;
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % length;
  }

  buildSecretPool({ maxLength = 12 } = {}) {
    const source = this.getSelectionVocabulary();
    const filtered = source.filter((word) => this.isGuessableSecretCandidate(word, { maxLength }));
    const scored = filtered
      .map((word) => ({ word, score: this.scoreSecretCandidate(word) }))
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
    return scored.map((item) => item.word);
  }

  buildSelectionContext() {
    const source = this.getSelectionVocabulary();
    let filteredPool = this.buildSecretPool({ maxLength: 12 });
    if (filteredPool.length < 5000) {
      filteredPool = this.buildSecretPool({ maxLength: 14 });
    }

    if (filteredPool.length < 200) {
      filteredPool = source.filter((word) => /^[a-z]{4,14}$/.test(word));
    }

    const allowlistIntersection = filteredPool.filter((word) => this.commonAllowlist.has(word));
    const preferAllowlist = allowlistIntersection.length >= 250;
    const preferredPool = preferAllowlist ? allowlistIntersection : filteredPool;

    this.lastSecretSelectionStats = {
      totalVocabSize: source.length,
      filteredCandidateSize: filteredPool.length,
      allowlistPresent: this.commonAllowlist.size > 0,
      allowlistIntersectionSize: allowlistIntersection.length,
      exampleCandidates: preferredPool.slice(0, 20),
    };

    return { source, pool: preferredPool, allowlistIntersection };
  }

  rememberRoomSecret(roomId, secret) {
    if (!roomId || !secret) return;
    if (!this.secretHistoryByRoom.has(roomId)) this.secretHistoryByRoom.set(roomId, []);
    const history = this.secretHistoryByRoom.get(roomId);
    history.push(secret);
    if (history.length > SECRET_HISTORY_SIZE) {
      history.splice(0, history.length - SECRET_HISTORY_SIZE);
    }
  }

  getSecretSelectionDebug() {
    const { totalVocabSize, filteredCandidateSize, allowlistPresent, allowlistIntersectionSize, exampleCandidates } = this.lastSecretSelectionStats;
    return {
      totalVocabSize,
      filteredCandidateSize,
      allowlistPresent,
      allowlistIntersectionSize,
      exampleCandidates,
    };
  }

  buildAliasMap(vocabulary) {
    const groupedAliases = new Map();

    vocabulary.forEach((word) => {
      const normalized = this.wordNormalizer.normalizeGuess(word);
      const canonical = normalized.canonical;
      if (!canonical) return;

      if (!groupedAliases.has(canonical)) groupedAliases.set(canonical, []);
      groupedAliases.get(canonical).push(word);
    });

    const aliasMap = new Map();
    groupedAliases.forEach((words, canonical) => {
      aliasMap.set(canonical, chooseRepresentative(words, canonical));
      words.forEach((word) => aliasMap.set(word, aliasMap.get(canonical)));
    });

    IRREGULAR_ALIASES.forEach((canonical, alias) => {
      if (this.vocabularySet.has(canonical)) aliasMap.set(alias, canonical);
    });

    return aliasMap;
  }

  resolveAlias(word) {
    const normalized = this.wordNormalizer.normalizeGuess(word);
    const canonical = normalized.canonical;
    if (!canonical) return "";
    return this.aliasMap.get(canonical) || this.aliasMap.get(word) || canonical;
  }

  normalizeForGuess(word) {
    return this.wordNormalizer.normalizeGuess(word);
  }

  load() {
    const rawWords = fs.readFileSync(this.vocabPath, "utf8").split(/\r?\n/);
    this.fullVocabulary = buildVocabulary(rawWords);
    this.vocabulary = [...this.fullVocabulary];
    this.vocabularySet = new Set(this.fullVocabulary);
    this.wordNormalizer = createWordNormalizer({ vocabulary: this.vocabularySet, blocklist: FOREIGN_STOPWORDS });
    this.aliasMap = this.buildAliasMap(this.fullVocabulary);

    this.fallback = new FallbackRanker(this.fullVocabulary, {
      resolveAlias: (guess) => this.resolveAlias(guess),
      normalizeGuess: (guess) => this.wordNormalizer.normalizeGuess(guess),
    });

    this.commonAllowlist = new Set(SemanticRankService.readWordList(this.commonAllowlistPath));

    if (!fs.existsSync(this.embeddingsPath)) {
      console.warn("[similarity] embeddings.trimmed.json missing; semantic ranking disabled.");
      return;
    }

    const raw = JSON.parse(fs.readFileSync(this.embeddingsPath, "utf8"));
    const vectors = new Map();
    Object.entries(raw.vectors || {}).forEach(([word, arr]) => {
      vectors.set(word, Float32Array.from(arr));
    });

    if (!vectors.size) {
      console.warn("[similarity] embeddings file loaded but vectors are empty; semantic ranking disabled.");
      return;
    }

    this.vectors = vectors;
    this.vocabulary = this.fullVocabulary.filter((word) => vectors.has(word));
    this.semanticEnabled = this.vocabulary.length > 0;
    console.log(`[similarity] semantic ranking enabled (${this.vocabulary.length}/${this.fullVocabulary.length} words).`);
  }

  pickTarget({ roomId = "global", roundId = 0 } = {}) {
    const { source, pool } = this.buildSelectionContext();
    const fallbackPool = source.length ? source : ["context"];
    const candidatePool = pool.length ? pool : fallbackPool;

    const recent = new Set(this.secretHistoryByRoom.get(roomId) || []);
    const noRepeatPool = candidatePool.filter((word) => !recent.has(word));
    const effectivePool = noRepeatPool.length ? noRepeatPool : candidatePool;

    const counter = (this.secretSelectionCounterByRoom.get(roomId) || 0) + 1;
    this.secretSelectionCounterByRoom.set(roomId, counter);
    const idx = this.deterministicIndex(`${roomId}:${roundId}:${counter}`, effectivePool.length);
    const chosen = effectivePool[idx] || fallbackPool[0] || "context";
    this.rememberRoomSecret(roomId, chosen);
    return chosen;
  }

  buildRound(targetWord) {
    const normalizedTarget = this.resolveAlias(targetWord);

    if (!this.semanticEnabled || !this.vectors.has(normalizedTarget)) {
      this.fallback.startRound(normalizedTarget);
      return {
        targetWord: normalizedTarget,
        rankMap: new Map([[normalizedTarget, 1]]),
        simsSorted: [1],
        semantic: false,
        evaluateGuess: async (guess) => this.fallback.evaluate(guess),
      };
    }

    const targetVec = this.vectors.get(normalizedTarget);
    const scored = this.vocabulary.map((word) => ({
      word,
      similarity: cosineSimilarity(targetVec, this.vectors.get(word)),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);

    const rankMap = new Map();
    const simsSorted = [];
    scored.forEach((item, index) => {
      rankMap.set(item.word, index + 1);
      simsSorted.push(item.similarity);
    });

    return {
      targetWord: normalizedTarget,
      rankMap,
      simsSorted,
      semantic: true,
      evaluateGuess: async (guess) => {
        const normalized = this.wordNormalizer.normalizeGuess(guess);
        if (!normalized.valid) {
          return { error: "Only recognized English words are allowed.", normalized };
        }

        const resolvedWord = this.resolveAlias(normalized.canonical);
        if (!this.vocabularySet.has(resolvedWord)) {
          return { error: `Only recognized words are allowed. \"${normalized.display || normalized.canonical}\" is not in the word list.`, normalized };
        }

        if (resolvedWord === normalizedTarget) {
          return {
            rank: 1,
            approx: false,
            similarity: 1,
            colorBand: colorBandForRank(1),
            mode: "exact",
            resolvedWord,
            canonicalWord: normalized.canonical,
            normalized,
          };
        }

        if (rankMap.has(resolvedWord)) {
          const rank = rankMap.get(resolvedWord);
          return {
            rank,
            approx: false,
            similarity: simsSorted[Math.max(0, rank - 1)] ?? 0,
            colorBand: colorBandForRank(rank),
            mode: "semantic",
            resolvedWord,
            canonicalWord: normalized.canonical,
            normalized,
          };
        }

        return this.fallback.evaluate(resolvedWord);
      },
    };
  }
}
