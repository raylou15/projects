import { colorBandForRank, clamp } from "./text.js";
import { createWordNormalizer } from "../../shared/wordNormalize.js";

function bigrams(value) {
  const padded = ` ${value} `;
  const grams = [];
  for (let i = 0; i < padded.length - 1; i += 1) grams.push(padded.slice(i, i + 2));
  return grams;
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let hit = 0;
  setA.forEach((item) => {
    if (setB.has(item)) hit += 1;
  });
  return hit / Math.max(setA.size, setB.size);
}

export class FallbackRanker {
  constructor(vocabulary, { resolveAlias = null, normalizeGuess = null } = {}) {
    this.vocabulary = vocabulary;
    this.vocabularySet = new Set(vocabulary);
    this.enabled = true;
    this.kind = "string-fallback";
    this.targetWord = null;
    this.resolveAlias = typeof resolveAlias === "function" ? resolveAlias : (guess) => guess;
    const defaultNormalizer = createWordNormalizer({ vocabulary: this.vocabularySet });
    this.normalizeGuess = typeof normalizeGuess === "function" ? normalizeGuess : (guess) => defaultNormalizer.normalizeGuess(guess);
  }

  startRound(targetWord) {
    const normalized = this.normalizeGuess(targetWord);
    this.targetWord = this.resolveAlias(normalized.canonical) || normalized.canonical;
  }

  evaluate(guess) {
    const normalized = this.normalizeGuess(guess);
    const clean = this.resolveAlias(normalized.canonical) || normalized.canonical;

    if (!clean) return { error: "Please enter a word.", normalized };
    if (!normalized.valid) return { error: "Only recognized English words are allowed.", normalized };

    if (!this.vocabularySet.has(clean)) {
      return { error: `Only recognized words are allowed. \"${normalized.display || normalized.canonical}\" is not in the word list.`, normalized };
    }

    if (clean === this.targetWord) {
      return {
        rank: 1,
        approx: false,
        similarity: 1,
        colorBand: colorBandForRank(1),
        mode: "exact",
        resolvedWord: clean,
        canonicalWord: normalized.canonical,
        normalized,
      };
    }

    const wordOverlap = overlap(clean.split(" "), this.targetWord.split(" "));
    const gramOverlap = overlap(bigrams(clean), bigrams(this.targetWord));
    const similarity = clamp(wordOverlap * 0.4 + gramOverlap * 0.6, 0, 1);
    const rank = Math.max(2, Math.round((1 - similarity) * Math.max(this.vocabulary.length, 1)));

    return {
      rank,
      approx: true,
      similarity,
      colorBand: colorBandForRank(rank),
      mode: "fallback",
      resolvedWord: clean,
      canonicalWord: normalized.canonical,
      normalized,
    };
  }
}
