import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embeddings";
const OLLAMA_GEN_URL = "http://127.0.0.1:11434/api/generate";
const EMBED_MODEL = "bge-m3";
const RERANK_MODEL = "dengcao/bge-reranker-v2-m3";
const INDEX_FILE = path.resolve(".opencode/vec-cache.json");
const MAX_CHUNK_CHARS = 2200;

const IGNORE_DIRS = new Set([
  "node_modules", ".wrangler", ".git", ".opencode", "private",
  "backups", "playwright-report", "test-results", "dist", "build"
]);
const ALLOWED_EXT = new Set([".js", ".mjs", ".css", ".html", ".sql", ".md", ".json"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (ALLOWED_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function chunkFile(relPath, content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  const STEP = 22;
  const OVERLAP = 4;

  for (let i = 0; i < lines.length; i += STEP - OVERLAP) {
    const slice = lines
      .slice(i, i + STEP)
      .map((l) => (l.length > 300 ? l.slice(0, 120) + " ...[DATA]" : l));
    const header = "FILE: " + relPath + " (lines " + (i + 1) + "-" + Math.min(i + STEP, lines.length) + ")\n";
    const text = (header + slice.join("\n")).slice(0, MAX_CHUNK_CHARS);
    if (text.trim().length > 40) {
      chunks.push({
        file: relPath,
        startLine: i + 1,
        endLine: Math.min(i + STEP, lines.length),
        text
      });
    }
  }
  return chunks;
}

async function embed(prompt) {
  const res = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: prompt.slice(0, MAX_CHUNK_CHARS) })
  });
  if (!res.ok) throw new Error("Ollama embed error: " + res.status);
  const data = await res.json();
  return data.embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function lexicalBoost(query, text) {
  const tokens = query.toLowerCase().split(/[^a-zа-яё0-9_]+/i).filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const low = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (low.includes(t)) hits++;
  return (hits / tokens.length) * 0.15;
}

async function rerankScore(query, docText) {
  try {
    const res = await fetch(OLLAMA_GEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RERANK_MODEL,
        prompt: "Query: " + query + "\nDocument: " + docText.slice(0, 1400),
        stream: false,
        options: { num_predict: 1 }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.rerank_score === "number") return data.rerank_score;
    return null;
  } catch {
    return null;
  }
}

async function buildIndex() {
  let cache = { files: {} };
  try {
    cache = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {}

  const files = walk(process.cwd());
  const activeRel = new Set();

  for (const full of files) {
    const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
    if (rel.startsWith("tools/") || rel === "package-lock.json") continue;
    activeRel.add(rel);

    const raw = fs.readFileSync(full, "utf8");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    if (cache.files[rel]?.hash === hash) continue;

    const rawChunks = chunkFile(rel, raw);
    const embeddedChunks = [];
    for (const ch of rawChunks) {
      const vec = await embed(ch.text);
      embeddedChunks.push({ ...ch, vec });
    }
    cache.files[rel] = { hash, chunks: embeddedChunks };
  }

  for (const rel of Object.keys(cache.files)) {
    if (!activeRel.has(rel)) delete cache.files[rel];
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(cache));
  return cache;
}

const args = process.argv.slice(2);
const cache = await buildIndex();

if (args[0] === "--index-only") {
  console.log("[RAG] Indexed " + Object.keys(cache.files).length + " files using " + EMBED_MODEL);
  process.exit(0);
}

const query = args.join(" ").trim();
if (!query) {
  console.error("Usage: node tools/rag-search.mjs <query> | --index-only");
  process.exit(1);
}

const qVec = await embed(query);
const candidates = [];
for (const entry of Object.values(cache.files)) {
  for (const ch of entry.chunks) {
    const score = cosine(qVec, ch.vec) + lexicalBoost(query, ch.text);
    candidates.push({ score, ...ch });
  }
}

candidates.sort((a, b) => b.score - a.score);
const topCandidates = candidates.slice(0, 8);

for (const cand of topCandidates) {
  const rr = await rerankScore(query, cand.text);
  if (rr !== null) cand.score = cand.score * 0.4 + rr * 0.6;
}
topCandidates.sort((a, b) => b.score - a.score);

for (const hit of topCandidates.slice(0, 3)) {
  console.log("\n--- [score=" + hit.score.toFixed(3) + "] " + hit.file + ":" + hit.startLine + "-" + hit.endLine + " ---");
  console.log(hit.text.split("\n").slice(1).join("\n"));
}