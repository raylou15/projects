import { normalizeGuess, colorBandForRank, clamp } from "./text.js";

function trigrams(value) {
  const padded = `  ${value}  `;
  const grams = [];
  for (let i = 0; i < padded.length - 2; i += 1) {
    grams.push(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  setA.forEach((item) => {
    if (setB.has(item)) intersect += 1;
  });
  return intersect / (setA.size + setB.size - intersect || 1);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const cols = b.length + 1;
  const prev = new Uint16Array(cols);
  const curr = new Uint16Array(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev.set(curr);
  }
  return prev[b.length];
}

function prefixSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length) || 1;
  let same = 0;
  const limit = Math.min(a.length, b.length);
  while (same < limit && a[same] === b[same]) same += 1;
  return same / maxLen;
}

function stableHash(word) {
  let h = 0;
  for (let i = 0; i < word.length; i += 1) {
    h = (h * 31 + word.charCodeAt(i)) % 1_000_000_007;
  }
  return h;
}

export class FallbackRanker {
  constructor(vocabulary, remoteHelper = null) {
    this.vocabulary = vocabulary;
    this.remoteHelper = remoteHelper;
    this.kind = "heuristic-fallback";
    this.targetWord = null;
    this.vocabIndex = new Map(vocabulary.map((word, idx) => [word, idx + 1]));
  }

  startRound(targetWord) {
    this.targetWord = normalizeGuess(targetWord);
  }

  frequencyProxy(word) {
    if (this.vocabIndex.has(word)) {
      return 1 - this.vocabIndex.get(word) / Math.max(this.vocabulary.length, 1);
    }
    return (stableHash(word) % 1000) / 1000;
  }

  scoreGuess(clean) {
    const trigramSim = jaccard(trigrams(clean), trigrams(this.targetWord));
    const edit = levenshtein(clean, this.targetWord);
    const editSim = 1 - edit / Math.max(clean.length, this.targetWord.length, 1);
    const pref = prefixSimilarity(clean, this.targetWord);
    const freq = this.frequencyProxy(clean);

    return clamp(trigramSim * 0.4 + editSim * 0.35 + pref * 0.2 + freq * 0.05, 0, 0.99999);
  }

  scoreToRank(score) {
    const vocabSize = Math.max(this.vocabulary.length, 500);
    const curved = Math.pow(1 - score, 1.45);
    return clamp(Math.floor(curved * (vocabSize - 2)) + 2, 2, vocabSize);
  }

  async evaluate(guess) {
    const clean = normalizeGuess(guess);
    if (!clean) return { error: "Please enter a word." };

    if (clean === this.targetWord) {
      return { rank: 1, approx: false, similarity: 1, colorBand: colorBandForRank(1), mode: "exact" };
    }

    let score = this.scoreGuess(clean);
    let remote = false;

    if (this.remoteHelper && !this.vocabIndex.has(clean)) {
      const remoteScore = await this.remoteHelper.relatedness(this.targetWord, clean);
      if (remoteScore !== null) {
        score = clamp(score * 0.65 + remoteScore * 0.35, 0, 0.99999);
        remote = true;
      }
    }

    const rank = this.scoreToRank(score);
    return {
      rank,
      approx: true,
      similarity: score,
      colorBand: colorBandForRank(rank),
      mode: remote ? "fallback+remote" : "fallback",
    };
  }
}
