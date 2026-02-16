import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");

const glovePath = process.argv[2];
if (!glovePath) {
  console.error("Usage: node scripts/buildEmbeddings.js /path/to/glove.6B.100d.txt");
  process.exit(1);
}

const vocabPath = path.resolve(serverRoot, "data/vocab-common.txt");
const outPath = path.resolve(serverRoot, "data/embeddings.trimmed.json");

const vocab = new Set(
  fs
    .readFileSync(vocabPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean),
);

const vectors = {};
let dims = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(glovePath, "utf8"),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const [word, ...vals] = line.trim().split(" ");
  if (!vocab.has(word)) continue;
  if (!dims) dims = vals.length;
  vectors[word] = vals.map(Number);
}

const payload = { dims, count: Object.keys(vectors).length, vectors };
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log(`Wrote ${payload.count} vectors to ${outPath}`);
