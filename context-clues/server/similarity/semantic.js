import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeGuess, canonicalizeGuess, colorBandForRank } from "./text.js";
import { FallbackRanker } from "./fallback.js";
import { RemoteSemanticHelper } from "./remoteSemantic.js";

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

function findEmbeddingsFile(dataDir) {
  if (!fs.existsSync(dataDir)) return null;
  const files = fs.readdirSync(dataDir).filter((name) => name.startsWith("embeddings.trimmed."));
  if (!files.length) return null;
  const preferred = files.find((f) => f.endsWith(".json"));
  return path.resolve(dataDir, preferred || files[0]);
}

export class SemanticRankService {
  constructor({ vocabPath = path.resolve(serverRoot, "data/vocab-common.txt") } = {}) {
    this.vocabPath = vocabPath;
    this.embeddingsPath = findEmbeddingsFile(path.resolve(serverRoot, "data"));
    this.vocabulary = [];
    this.vocabularySet = new Set();
    this.aliasMap = new Map();
    this.vectors = new Map();
    this.semanticEnabled = false;
    this.remoteHelper = new RemoteSemanticHelper({
      enabled: String(process.env.ENABLE_REMOTE_SEMANTICS || "false") === "true",
    });
    this.fallback = null;
  }

  buildAliasMap(vocabulary) {
    const aliasMap = new Map();
    vocabulary.forEach((word) => {
      const canonical = canonicalizeGuess(word);
      if (!canonical) return;
      if (!aliasMap.has(canonical)) {
        aliasMap.set(canonical, word);
      }
    });
    return aliasMap;
  }

  resolveAlias(word) {
    const normalized = normalizeGuess(word);
    if (!normalized) return "";
    return this.aliasMap.get(normalized) || normalized;
  }

  load() {
    this.vocabulary = fs
      .readFileSync(this.vocabPath, "utf8")
      .split(/\r?\n/)
      .map((line) => normalizeGuess(line))
      .filter(Boolean);
    this.vocabularySet = new Set(this.vocabulary);
    this.aliasMap = this.buildAliasMap(this.vocabulary);

    this.fallback = new FallbackRanker(this.vocabulary, this.remoteHelper, (guess) => this.resolveAlias(guess));

    if (!this.embeddingsPath || !fs.existsSync(this.embeddingsPath)) {
      console.warn("[similarity] embeddings.trimmed.* missing; semantic mode disabled.");
      return;
    }

    const raw = JSON.parse(fs.readFileSync(this.embeddingsPath, "utf8"));
    const vectors = new Map();
    Object.entries(raw.vectors || {}).forEach(([word, arr]) => vectors.set(word, Float32Array.from(arr)));

    if (!vectors.size) {
      console.warn("[similarity] embeddings loaded but empty; semantic mode disabled.");
      return;
    }

    this.vectors = vectors;
    this.vocabulary = this.vocabulary.filter((word) => vectors.has(word));
    this.vocabularySet = new Set(this.vocabulary);
    this.aliasMap = this.buildAliasMap(this.vocabulary);
    this.semanticEnabled = this.vocabulary.length > 0;
    this.fallback = new FallbackRanker(this.vocabulary, this.remoteHelper, (guess) => this.resolveAlias(guess));
    console.log(`[similarity] semantic ranking enabled (${this.vocabulary.length} words).`);
  }

  pickTarget() {
    if (!this.vocabulary.length) return "context";
    return this.vocabulary[Math.floor(Math.random() * this.vocabulary.length)];
  }

  verifyRankMap(rankMap) {
    const minimum = Math.floor(this.vocabulary.length * 0.9);
    if (rankMap.size < minimum) {
      console.warn(`[similarity] rank map too small (${rankMap.size}/${this.vocabulary.length}).`);
    }
    const samples = [];
    for (let i = 0; i < 5 && this.vocabulary.length; i += 1) {
      const word = this.vocabulary[Math.floor(Math.random() * this.vocabulary.length)];
      samples.push(`${word}:${rankMap.get(word) ?? "NA"}`);
    }
    const uniqueRanks = new Set(samples.map((s) => s.split(":")[1])).size;
    console.log(`[similarity] rank samples ${samples.join(", ")}`);
    if (uniqueRanks <= 1) console.warn("[similarity] sampled ranks are identical; check embeddings.");
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
    const scored = this.vocabulary.map((word) => ({ word, similarity: cosineSimilarity(targetVec, this.vectors.get(word)) }));
    scored.sort((a, b) => b.similarity - a.similarity);

    const rankMap = new Map();
    const simsSorted = [];
    scored.forEach((item, index) => {
      rankMap.set(item.word, index + 1);
      simsSorted.push(item.similarity);
    });

    this.verifyRankMap(rankMap);

    return {
      targetWord: normalizedTarget,
      rankMap,
      simsSorted,
      semantic: true,
      evaluateGuess: async (guess) => {
        const canonical = canonicalizeGuess(guess);
        if (!canonical) return { error: "Please enter a word." };

        const clean = this.resolveAlias(canonical);
        if (!this.vocabularySet.has(clean)) {
          return { error: `Only recognized words are allowed. \"${canonical}\" is not in the word list.` };
        }

        if (clean === normalizedTarget) {
          return {
            rank: 1,
            approx: false,
            similarity: 1,
            colorBand: colorBandForRank(1),
            mode: "exact",
            resolvedWord: clean,
            canonicalWord: canonical,
          };
        }

        if (rankMap.has(clean)) {
          const rank = rankMap.get(clean);
          return {
            rank,
            approx: false,
            similarity: simsSorted[Math.max(0, rank - 1)] ?? 0,
            colorBand: colorBandForRank(rank),
            mode: "semantic",
            resolvedWord: clean,
            canonicalWord: canonical,
          };
        }

        return this.fallback.evaluate(clean);
      },
    };
  }
}
