import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { buildVocabulary } from "../game/vocab.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const dataDir = path.resolve(serverRoot, "data");

const vocabPath = path.join(dataDir, "vocab-common.txt");
const embeddingsPath = path.join(dataDir, "embeddings.trimmed.json");

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function backupIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function parseArgs(argv) {
  const args = { vocabSources: [], glovePath: "", minWords: 10000 };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--vocab-source") args.vocabSources.push(argv[++i]);
    else if (token === "--glove") args.glovePath = argv[++i];
    else if (token === "--min-words") args.minWords = Number(argv[++i] || 10000);
  }
  return args;
}

function readWordsFromFile(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => String(line || "").trim().split(/\s+/)[0] || "");
}

async function buildEmbeddings(glovePath, vocabSet) {
  if (!glovePath) return null;
  if (!fs.existsSync(glovePath)) throw new Error(`GloVe path not found: ${glovePath}`);

  const vectors = {};
  let dims = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(glovePath, "utf8"), crlfDelay: Infinity });

  for await (const line of rl) {
    const [word, ...vals] = line.trim().split(" ");
    if (!vocabSet.has(word)) continue;
    if (!dims) dims = vals.length;
    vectors[word] = vals.map(Number);
  }

  return { dims, count: Object.keys(vectors).length, vectors };
}

async function main() {
  const args = parseArgs(process.argv);
  const sources = args.vocabSources.length ? args.vocabSources : [vocabPath];
  const allRaw = [];

  for (const source of sources) {
    const abs = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
    if (!fs.existsSync(abs)) throw new Error(`Missing vocab source file: ${abs}`);
    for (const word of readWordsFromFile(abs)) allRaw.push(word);
  }

  const nextVocab = buildVocabulary(allRaw);
  if (nextVocab.length < args.minWords) {
    throw new Error(`Refusing to write vocab: ${nextVocab.length} words (< ${args.minWords}).`);
  }

  const vocabBak = backupIfExists(vocabPath);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(vocabPath, `${nextVocab.join("\n")}\n`);

  let embBak = null;
  if (args.glovePath) {
    const payload = await buildEmbeddings(args.glovePath, new Set(nextVocab));
    if (!payload?.count) throw new Error("Embeddings build produced zero vectors.");
    embBak = backupIfExists(embeddingsPath);
    fs.writeFileSync(embeddingsPath, JSON.stringify(payload));
    console.log(`[rebuild] embeddings count=${payload.count} dims=${payload.dims}`);
  }

  console.log(`[rebuild] vocab words=${nextVocab.length}`);
  if (vocabBak) console.log(`[rebuild] vocab backup=${vocabBak}`);
  if (embBak) console.log(`[rebuild] embeddings backup=${embBak}`);
}

main().catch((error) => {
  console.error(`[rebuild] failed: ${error.message}`);
  process.exit(1);
});
