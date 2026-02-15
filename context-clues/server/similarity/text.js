const IRREGULAR_ALIASES = new Map([
  ["men", "man"],
  ["women", "woman"],
  ["children", "child"],
  ["mice", "mouse"],
  ["geese", "goose"],
  ["teeth", "tooth"],
  ["feet", "foot"],
  ["oxen", "ox"],
  ["people", "person"],
  ["indices", "index"],
  ["matrices", "matrix"],
  ["data", "data"],
]);

export function normalizeGuess(input = "") {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function undoubleConsonant(value) {
  if (value.length < 3) return value;
  const last = value[value.length - 1];
  const prev = value[value.length - 2];
  if (last === prev && /[b-df-hj-np-tv-z]/.test(last)) return value.slice(0, -1);
  return value;
}

export function singularizeToken(token = "") {
  if (!token) return "";
  if (IRREGULAR_ALIASES.has(token)) return IRREGULAR_ALIASES.get(token);

  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;

  if (token.endsWith("ves") && token.length > 4) {
    const base = token.slice(0, -3);
    if (base.endsWith("i")) return `${base.slice(0, -1)}ife`;
    return `${base}f`;
  }

  if (/(ches|shes|sses|xes|zes|oes)$/.test(token) && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && token.length > 3 && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }

  if (token.endsWith("ing") && token.length > 5) {
    const base = undoubleConsonant(token.slice(0, -3));
    if (base.length > 2) return base;
  }

  if (token.endsWith("ed") && token.length > 4) {
    const base = undoubleConsonant(token.slice(0, -2));
    if (base.length > 2) return base;
  }

  return token;
}

export function canonicalizeGuess(input = "") {
  const clean = normalizeGuess(input);
  if (!clean) return "";

  const canonical = clean
    .split(" ")
    .map((token) => singularizeToken(token))
    .filter(Boolean)
    .join(" ");

  return canonical || clean;
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
