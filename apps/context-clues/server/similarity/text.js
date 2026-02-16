import { canonicalizeGuess, normalizeGuess as sharedNormalizeGuess } from "../../shared/wordNormalize.js";

export function normalizeGuess(input = "") {
  return sharedNormalizeGuess(input).display;
}

export { canonicalizeGuess };

export function colorBandForRank(rank) {
  if (rank === 1) return "exact";
  if (rank <= 50) return "green";
  if (rank <= 500) return "yellow";
  return "red";
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
