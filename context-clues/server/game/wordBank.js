export const WORD_BANK = [
  "volcano",
  "astronaut",
  "haunted house",
  "time machine",
  "treasure map",
  "rainforest",
  "roller coaster",
  "dragon",
  "campfire",
  "library",
  "pirate ship",
  "northern lights",
  "jigsaw puzzle",
  "midnight snack",
  "secret tunnel",
  "arcade",
  "lightning storm",
  "deep ocean",
  "magic trick",
  "snow globe",
];

const SYNONYM_HINTS = {
  volcano: ["lava", "eruption", "mountain"],
  astronaut: ["space", "helmet", "orbit"],
  rainforest: ["jungle", "humid", "canopy"],
  dragon: ["myth", "fire", "wings"],
  library: ["books", "quiet", "shelves"],
};

export function randomWord(exclude = []) {
  const blocked = new Set(exclude.map((entry) => entry.toLowerCase()));
  const available = WORD_BANK.filter((word) => !blocked.has(word.toLowerCase()));
  const source = available.length ? available : WORD_BANK;
  return source[Math.floor(Math.random() * source.length)];
}

function normalize(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(str) {
  const value = ` ${str} `;
  const list = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    list.push(value.slice(i, i + 2));
  }
  return list;
}

function overlapScore(a, b) {
  const as = new Set(a);
  const bs = new Set(b);
  if (!as.size || !bs.size) return 0;

  let inter = 0;
  as.forEach((part) => {
    if (bs.has(part)) inter += 1;
  });

  return inter / Math.max(as.size, bs.size);
}

export function similarityHint(guess, target) {
  const cleanGuess = normalize(guess);
  const cleanTarget = normalize(target);

  if (!cleanGuess) return { score: 0, label: "No guess" };
  if (cleanGuess === cleanTarget) return { score: 100, label: "Exact match!" };

  const wordOverlap = overlapScore(cleanGuess.split(" "), cleanTarget.split(" "));
  const gramOverlap = overlapScore(bigrams(cleanGuess), bigrams(cleanTarget));
  const synonymBoost = (SYNONYM_HINTS[cleanTarget] || []).some((hint) =>
    cleanGuess.includes(hint),
  )
    ? 0.2
    : 0;

  const score = Math.min(95, Math.round((wordOverlap * 0.45 + gramOverlap * 0.45 + synonymBoost) * 100));

  let label = "Ice cold";
  if (score >= 75) label = "Very warm";
  else if (score >= 50) label = "Warm";
  else if (score >= 25) label = "Cool";

  return { score, label };
}
