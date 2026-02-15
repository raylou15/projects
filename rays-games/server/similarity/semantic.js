import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeGuess, canonicalizeGuess, colorBandForRank } from "./text.js";
import { buildVocabulary } from "../game/vocab.js";
import { FallbackRanker } from "./fallback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");

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
  }

  buildAliasMap(vocabulary) {
    const aliasMap = new Map();
    vocabulary.forEach((word) => {
      const canonical = canonicalizeGuess(word);
      if (!canonical) return;
      if (!aliasMap.has(canonical)) aliasMap.set(canonical, word);
    });
    return aliasMap;
  }

  resolveAlias(word) {
    const canonical = canonicalizeGuess(word);
    if (!canonical) return "";
    return this.aliasMap.get(canonical) || canonical;
  }

  load() {
    this.fullVocabulary = buildVocabulary(fs.readFileSync(this.vocabPath, "utf8").split(/\r?\n/));
    this.vocabulary = [...this.fullVocabulary];
    this.vocabularySet = new Set(this.fullVocabulary);
    this.aliasMap = this.buildAliasMap(this.fullVocabulary);

    this.fallback = new FallbackRanker(this.fullVocabulary, (guess) => this.resolveAlias(guess));

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
    const normalizedTarget = this.resolveAlias(canonicalizeGuess(targetWord));

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
        const canonicalWord = canonicalizeGuess(guess);
        if (!canonicalWord) return { error: "Please enter a word." };

        const resolvedWord = this.resolveAlias(canonicalWord);
        if (!this.vocabularySet.has(resolvedWord)) {
          return { error: `Only recognized words are allowed. \"${normalizeGuess(guess)}\" is not in the word list.` };
        }

        if (resolvedWord === normalizedTarget) {
          return {
            rank: 1,
            approx: false,
            similarity: 1,
            colorBand: colorBandForRank(1),
            mode: "exact",
            resolvedWord,
            canonicalWord,
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
            canonicalWord,
          };
        }

        return this.fallback.evaluate(resolvedWord);
      },
    };
  }
}
