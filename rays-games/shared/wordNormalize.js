const TOKEN_PATTERN = /^[a-z]+(?:['-][a-z]+)*$/;
const LETTERS_ONLY_PATTERN = /^[a-z]+$/;

const IRREGULAR_BASE_FORMS = new Map([
  ["men", "man"],
  ["women", "woman"],
  ["children", "child"],
  ["mice", "mouse"],
  ["geese", "goose"],
  ["teeth", "tooth"],
  ["feet", "foot"],
  ["people", "person"],
  ["oxen", "ox"],
  ["indices", "index"],
  ["matrices", "matrix"],
  ["dice", "die"],
  ["data", "datum"],
  ["criteria", "criterion"],
  ["media", "medium"],
  ["ran", "run"],
  ["running", "run"],
  ["went", "go"],
  ["gone", "go"],
  ["better", "good"],
  ["best", "good"],
]);

const UNINFLECTED_EXCEPTIONS = new Set([
  "glass",
  "class",
  "grass",
  "bass",
  "business",
  "news",
  "series",
  "species",
  "analysis",
  "thesis",
  "crisis",
  "status",
]);

const DEFAULT_BLOCKLIST = new Set([
  "que",
  "und",
  "les",
]);

function collapseWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toAsciiWord(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sanitizeToken(rawToken = "") {
  const ascii = toAsciiWord(rawToken)
    .replace(/^[^a-z'-]+|[^a-z'-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/'{2,}/g, "'")
    .replace(/(^['-]+|['-]+$)/g, "");
  return ascii;
}

function undoubleFinalConsonant(value = "") {
  if (value.length < 4) return value;
  const last = value[value.length - 1];
  const prev = value[value.length - 2];
  if (last === prev && /[b-df-hj-np-tv-z]/.test(last)) return value.slice(0, -1);
  return value;
}

function lemmaCandidatesFromToken(token = "") {
  const candidates = new Set([token]);
  if (!token) return candidates;

  if (token.endsWith("'s") && token.length > 3) candidates.add(token.slice(0, -2));
  if (token.endsWith("s'") && token.length > 3) candidates.add(token.slice(0, -1));

  if (IRREGULAR_BASE_FORMS.has(token)) candidates.add(IRREGULAR_BASE_FORMS.get(token));
  if (UNINFLECTED_EXCEPTIONS.has(token)) return candidates;

  if (token.endsWith("ies") && token.length > 4) candidates.add(`${token.slice(0, -3)}y`);

  if (token.endsWith("ves") && token.length > 4) {
    candidates.add(`${token.slice(0, -3)}f`);
    candidates.add(`${token.slice(0, -3)}fe`);
  }

  if (/(ches|shes|sses|xes|zes)$/.test(token) && token.length > 4) candidates.add(token.slice(0, -2));
  if (token.endsWith("oes") && token.length > 4) candidates.add(token.slice(0, -2));

  if (token.endsWith("s") && token.length > 3 && !/(ss|us|is)$/.test(token)) {
    candidates.add(token.slice(0, -1));
  }

  if (token.endsWith("ing") && token.length > 5) {
    const stem = token.slice(0, -3);
    candidates.add(stem);
    candidates.add(undoubleFinalConsonant(stem));
    if (!stem.endsWith("e")) candidates.add(`${stem}e`);
  }

  if (token.endsWith("ied") && token.length > 4) candidates.add(`${token.slice(0, -3)}y`);

  if (token.endsWith("ed") && token.length > 4) {
    const stem = token.slice(0, -2);
    candidates.add(stem);
    candidates.add(undoubleFinalConsonant(stem));
    if (!stem.endsWith("e")) candidates.add(`${stem}e`);
  }

  return candidates;
}

function tokenize(raw = "") {
  const compact = collapseWhitespace(raw);
  if (!compact) return [];
  return compact
    .split(" ")
    .map(sanitizeToken)
    .filter(Boolean)
    .filter((token) => TOKEN_PATTERN.test(token));
}

function scoreCandidate(candidate = "", token = "") {
  let score = 0;
  score += candidate.length;
  if (candidate === token) score += 1;
  if (candidate.endsWith("ing") || candidate.endsWith("ed") || candidate.endsWith("es")) score += 2;
  return score;
}

function chooseBestCandidate(token, vocabSet = null) {
  const candidates = [...lemmaCandidatesFromToken(token)].filter((candidate) => candidate && LETTERS_ONLY_PATTERN.test(candidate));
  if (!candidates.length) return token;

  const inVocab = vocabSet ? candidates.filter((candidate) => vocabSet.has(candidate)) : [];
  const pool = inVocab.length ? inVocab : candidates;

  pool.sort((a, b) => scoreCandidate(a, token) - scoreCandidate(b, token) || a.localeCompare(b));
  return pool[0] || token;
}

export function createWordNormalizer({ vocabulary = null, blocklist = DEFAULT_BLOCKLIST } = {}) {
  const vocabSet = vocabulary ? new Set(vocabulary) : null;
  const denySet = blocklist instanceof Set ? blocklist : new Set(blocklist || []);

  function normalizeGuess(raw = "") {
    const cleaned = collapseWhitespace(raw);
    const tokens = tokenize(cleaned);
    const display = tokens.join(" ");

    if (!display) {
      return {
        input: String(raw || ""),
        cleaned,
        display: "",
        canonical: "",
        valid: false,
        reason: "empty_or_invalid",
      };
    }

    const nonAscii = tokens.some((token) => /[^\x00-\x7F]/.test(token));
    if (nonAscii) {
      return { input: String(raw || ""), cleaned, display, canonical: "", valid: false, reason: "non_ascii" };
    }

    const canonicalTokens = [];
    let reason = "ok";

    for (const token of tokens) {
      if (denySet.has(token)) {
        return {
          input: String(raw || ""),
          cleaned,
          display,
          canonical: "",
          valid: false,
          reason: "blocked_word",
          blockedToken: token,
        };
      }

      const base = chooseBestCandidate(token, vocabSet);
      canonicalTokens.push(base);

      if (base !== token && reason === "ok") reason = "canonicalized";
    }

    const canonical = canonicalTokens.join(" ");

    if (vocabSet && !vocabSet.has(canonical)) {
      return {
        input: String(raw || ""),
        cleaned,
        display,
        canonical,
        valid: false,
        reason: "not_in_vocab",
      };
    }

    return {
      input: String(raw || ""),
      cleaned,
      display,
      canonical,
      valid: true,
      reason,
    };
  }

  return {
    normalizeGuess,
    canonicalizeGuess(raw = "") {
      return normalizeGuess(raw).canonical;
    },
    isAsciiEnglishToken(token = "") {
      return TOKEN_PATTERN.test(token);
    },
  };
}

const defaultNormalizer = createWordNormalizer();

export function normalizeGuess(raw = "") {
  return defaultNormalizer.normalizeGuess(raw);
}

export function canonicalizeGuess(raw = "") {
  return defaultNormalizer.canonicalizeGuess(raw);
}

export function isAsciiEnglishToken(token = "") {
  return defaultNormalizer.isAsciiEnglishToken(token);
}

export { DEFAULT_BLOCKLIST, TOKEN_PATTERN };
