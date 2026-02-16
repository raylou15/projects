import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWordNormalizer } from "../../shared/wordNormalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const vocabPath = path.resolve(__dirname, "../data/vocab-common.txt");
const vocab = new Set(fs.readFileSync(vocabPath, "utf8").split(/\r?\n/).filter(Boolean));
const normalizer = createWordNormalizer({ vocabulary: vocab });

const checks = [
  ["hamburgers", "hamburger"],
  ["armies", "army"],
  ["militaries", "military"],
  ["running", "run"],
  ["ran", "run"],
  ["cat's", "cat"],
];

let failed = 0;
for (const [input, expected] of checks) {
  const got = normalizer.normalizeGuess(input).canonical;
  if (got !== expected) {
    failed += 1;
    console.error(`FAIL ${input} => ${got} (expected ${expected})`);
  } else {
    console.log(`OK ${input} => ${got}`);
  }
}

const nonEnglish = ["que", "und", "les"];
for (const token of nonEnglish) {
  const out = normalizer.normalizeGuess(token);
  if (out.valid) {
    failed += 1;
    console.error(`FAIL ${token} should be blocked`);
  } else {
    console.log(`OK ${token} blocked (${out.reason})`);
  }
}

if (failed) process.exit(1);
