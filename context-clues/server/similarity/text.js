export function normalizeGuess(input = "") {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input = "") {
  const clean = normalizeGuess(input);
  return clean ? clean.split(" ") : [];
}

export function colorBandForRank(rank) {
  if (rank === 1) return "exact";
  if (rank <= 50) return "green";
  if (rank <= 500) return "yellow";
  return "red";
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
