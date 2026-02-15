import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeGuess, tokenize, colorBandForRank, clamp } from "./text.js";
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

function averageVectors(vectors) {
  if (!vectors.length) return null;
  const dims = vectors[0].length;
  const out = new Float32Array(dims);
  vectors.forEach((vec) => {
    for (let i = 0; i < dims; i += 1) out[i] += vec[i];
  });
  for (let i = 0; i < dims; i += 1) out[i] /= vectors.length;
  return out;
}

function upperBoundDesc(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid] >= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class SemanticRankService {
  constructor({
    vocabPath = path.resolve(serverRoot, "data/vocab-common.txt"),
    embeddingsPath = path.resolve(serverRoot, "data/embeddings.trimmed.json"),
  } = {}) {
    this.vocabPath = vocabPath;
    this.embeddingsPath = embeddingsPath;
    this.vocabulary = [];
    this.vectors = new Map();
    this.fallback = null;
    this.semanticEnabled = false;
  }

  load() {
    this.vocabulary = fs
      .readFileSync(this.vocabPath, "utf8")
      .split(/\r?\n/)
      .map((line) => normalizeGuess(line))
      .filter(Boolean);

    this.fallback = new FallbackRanker(this.vocabulary);

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
    this.vocabulary = this.vocabulary.filter((word) => vectors.has(word));
    this.semanticEnabled = this.vocabulary.length > 0;
    console.log(`[similarity] semantic ranking enabled (${this.vocabulary.length} words).`);
  }

  pickTarget() {
    if (!this.vocabulary.length) return "context";
    return this.vocabulary[Math.floor(Math.random() * this.vocabulary.length)];
  }

  buildRound(targetWord) {
    const normalizedTarget = normalizeGuess(targetWord);

    if (!this.semanticEnabled || !this.vectors.has(normalizedTarget)) {
      this.fallback.startRound(normalizedTarget);
      return {
        targetWord: normalizedTarget,
        rankMap: new Map([[normalizedTarget, 1]]),
        simsSorted: [1],
        semantic: false,
        evaluateGuess: (guess) => this.fallback.evaluate(guess),
      };
    }

    const targetVec = this.vectors.get(normalizedTarget);
    const scored = this.vocabulary.map((word) => {
      const similarity = cosineSimilarity(targetVec, this.vectors.get(word));
      return { word, similarity };
    });
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
      evaluateGuess: (guess) => {
        const clean = normalizeGuess(guess);
        if (!clean) return { error: "Please enter a word." };

        if (rankMap.has(clean)) {
          const rank = rankMap.get(clean);
          return {
            rank,
            approx: false,
            similarity: simsSorted[Math.max(0, rank - 1)] ?? 0,
            colorBand: colorBandForRank(rank),
          };
        }

        const tokenVectors = tokenize(clean)
          .map((token) => this.vectors.get(token))
          .filter(Boolean);

        if (!tokenVectors.length) {
          return { error: `Unknown word: "${clean}". Try another word.` };
        }

        const avg = averageVectors(tokenVectors);
        const similarity = cosineSimilarity(avg, targetVec);
        const insertion = upperBoundDesc(simsSorted, similarity);
        const approxRank = clamp(insertion + 1, 2, simsSorted.length + 1);

        return {
          rank: approxRank,
          approx: true,
          similarity,
          colorBand: colorBandForRank(approxRank),
        };
      },
    };
  }
}
