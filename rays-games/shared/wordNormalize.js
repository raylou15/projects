const TOKEN_PATTERN = /^[a-z]+(?:'[a-z]+)?$/;

const IRREGULAR_SINGULARS = new Map([
  ["men", "man"],
  ["women", "woman"],
  ["children", "child"],
  ["mice", "mouse"],
  ["geese", "goose"],
  ["teeth", "tooth"],
  ["feet", "foot"],
  ["people", "person"],
  ["indices", "index"],
  ["matrices", "matrix"],
  ["dice", "die"],
  ["oxen", "ox"],
  ["data", "datum"],
  ["criteria", "criterion"],
  ["media", "medium"],
]);

const S_SUFFIX_EXCEPTIONS = new Set([
  "glass",
  "class",
  "bass",
  "grass",
  "press",
  "chess",
  "guess",
  "news",
  "thesis",
  "analysis",
  "crisis",
  "series",
  "species",
]);

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanToken(rawToken = "") {
  return rawToken
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[^a-z']+|[^a-z']+$/g, "");
}

function undoubleFinalConsonant(value) {
  if (value.length < 4) return value;
  const last = value[value.length - 1];
  const prev = value[value.length - 2];
  if (last === prev && /[b-df-hj-np-tv-z]/.test(last)) return value.slice(0, -1);
  return value;
}

function singularize(token) {
  if (!token) return "";
  if (IRREGULAR_SINGULARS.has(token)) return IRREGULAR_SINGULARS.get(token);
  if (S_SUFFIX_EXCEPTIONS.has(token)) return token;

  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;

  if (/(ches|shes|sses|xes|zes|oes)$/.test(token) && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && token.length > 3 && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }

  if (token.endsWith("ing") && token.length > 5) {
    return undoubleFinalConsonant(token.slice(0, -3));
  }

  if (token.endsWith("ed") && token.length > 4) {
    return undoubleFinalConsonant(token.slice(0, -2));
  }

  return token;
}

function tokenize(raw = "") {
  const compact = collapseWhitespace(String(raw || ""));
  if (!compact) return [];

  return compact
    .split(" ")
    .map(cleanToken)
    .filter(Boolean)
    .filter((token) => TOKEN_PATTERN.test(token));
}

export function normalizeGuess(raw = "") {
  const tokens = tokenize(raw);
  const display = tokens.join(" ");
  const canonical = tokens.map(singularize).filter(Boolean).join(" ");
  return { display, canonical };
}

export function canonicalizeGuess(raw = "") {
  return normalizeGuess(raw).canonical;
}

export function isAsciiEnglishToken(token = "") {
  return TOKEN_PATTERN.test(token);
}
