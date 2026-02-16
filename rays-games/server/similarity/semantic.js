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
  } = {}) {
    this.vocabPath = vocabPath;
    this.embeddingsPath = embeddingsPath;
    this.vocabulary = [];
    this.fullVocabulary = [];
    this.vocabularySet = new Set();
    this.aliasMap = new Map();
    this.vectors = new Map();
    this.fallback = null;
    this.semanticEnabled = false;
    this.wordNormalizer = createWordNormalizer();
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

  pickTarget() {
    if (!this.vocabulary.length) return "context";
    return this.vocabulary[Math.floor(Math.random() * this.vocabulary.length)];
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
