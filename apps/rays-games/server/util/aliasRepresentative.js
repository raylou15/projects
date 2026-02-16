const INTRINSIC_S_EXCEPTIONS = new Set([
  "glass",
  "chess",
  "news",
  "physics",
  "series",
  "species",
  "class",
  "analysis",
  "thesis",
  "crisis",
]);

const SUFFIX_PENALTIES = [
  { suffix: "ies", penalty: 80, intrinsicSafe: false },
  { suffix: "es", penalty: 60, intrinsicSafe: false },
  { suffix: "s", penalty: 40, intrinsicSafe: true },
  { suffix: "ed", penalty: 30, intrinsicSafe: false },
  { suffix: "ing", penalty: 25, intrinsicSafe: false },
];

function hasIntrinsicTrailingS(word) {
  return INTRINSIC_S_EXCEPTIONS.has(word);
}

export function scoreCandidate(word, canonical) {
  if (!word) return Number.POSITIVE_INFINITY;
  if (word === canonical) return Number.NEGATIVE_INFINITY;

  let score = 0;

  for (const { suffix, penalty, intrinsicSafe } of SUFFIX_PENALTIES) {
    if (!word.endsWith(suffix)) continue;
    if (intrinsicSafe && hasIntrinsicTrailingS(word)) continue;
    score += penalty;
    break;
  }

  if (word.length > canonical.length) score += word.length - canonical.length;
  score += 0.5 * word.length;

  return score;
}

export function chooseRepresentative(words, canonical) {
  const uniqueWords = [...new Set((words || []).filter(Boolean))];
  if (!uniqueWords.length) return canonical || "";

  if (canonical && uniqueWords.includes(canonical)) return canonical;

  return uniqueWords
    .map((word, index) => ({ word, index, score: scoreCandidate(word, canonical || "") }))
    .sort((a, b) => a.score - b.score || a.word.length - b.word.length || a.word.localeCompare(b.word) || a.index - b.index)[0]
    .word;
}
