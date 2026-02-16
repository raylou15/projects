const WORD_PATTERN = /^[a-z]+(?:['-][a-z]+)*$/;

export const FOREIGN_STOPWORDS = new Set([
  "que",
  "qui",
  "como",
  "con",
  "sin",
  "una",
  "uno",
  "las",
  "los",
  "para",
  "por",
  "pero",
  "dans",
  "avec",
  "sans",
  "pour",
  "vous",
  "nous",
  "der",
  "die",
  "das",
  "und",
  "nicht",
  "ein",
  "eine",
  "les",
  "des",
  "gli",
  "della",
  "del",
  "de",
  "el",
  "la",
  "le",
  "il",
  "lo",
  "y",
  "et",
  "mit",
  "auf",
  "che",
  "per",
]);

const NAME_BLOCKLIST = new Set(["mohamed", "mohammad", "john", "mary", "james", "maria"]);

function normalizeVocabToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .trim();
}

export function isAllowedVocabToken(token = "") {
  if (!token) return false;
  if (token.length < 3) return false;
  if (!WORD_PATTERN.test(token)) return false;
  if (FOREIGN_STOPWORDS.has(token)) return false;
  if (NAME_BLOCKLIST.has(token)) return false;
  if (/[^\x00-\x7F]/.test(token)) return false;
  return true;
}

export function buildVocabulary(rawWords = []) {
  const out = new Set();

  for (const rawWord of rawWords) {
    const token = normalizeVocabToken(rawWord);
    if (!isAllowedVocabToken(token)) continue;
    out.add(token);
  }

  return [...out].sort();
}
