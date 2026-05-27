#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/compression/fht.ts
function log2PowerOfTwo(n) {
  if (n <= 0)
    return -1;
  let k = 0;
  let v = n;
  while ((v & 1) === 0) {
    v >>= 1;
    k++;
  }
  return v === 1 ? k : -1;
}
function fastHadamardTransform(x) {
  const D = x.length;
  const logD = log2PowerOfTwo(D);
  if (logD < 0) {
    throw new Error(`fastHadamardTransform: length must be a power of two, got ${D}`);
  }
  let h = 1;
  while (h < D) {
    const twoH = h << 1;
    for (let i = 0;i < D; i += twoH) {
      for (let j = i;j < i + h; j++) {
        const a = x[j];
        const b = x[j + h];
        x[j] = a + b;
        x[j + h] = a - b;
      }
    }
    h = twoH;
  }
  const invSqrtD = 1 / Math.sqrt(D);
  for (let i = 0;i < D; i++) {
    x[i] = x[i] * invSqrtD;
  }
}
function makeXorshift128(seedHex) {
  const FNV_OFFSET = 2166136261;
  const FNV_PRIME = 16777619;
  const seeds = new Uint32Array(4);
  for (let k = 0;k < 4; k++) {
    let h = (FNV_OFFSET ^ k * 2654435769) >>> 0;
    for (let i = 0;i < seedHex.length; i++) {
      h ^= seedHex.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    seeds[k] = h === 0 ? 2654435769 : h;
  }
  let s0 = seeds[0];
  let s1 = seeds[1];
  let s2 = seeds[2];
  let s3 = seeds[3];
  return function next() {
    let t = s0 ^ s0 << 11;
    t ^= t >>> 8;
    s0 = s1;
    s1 = s2;
    s2 = s3;
    s3 = s3 ^ s3 >>> 19 ^ (t ^ t >>> 8);
    return s3 >>> 0;
  };
}
function rotateWithSeed(x, seedHex) {
  const D = x.length;
  const rng = makeXorshift128(seedHex);
  for (let i = 0;i < D; i += 32) {
    const word = rng();
    const lim = Math.min(32, D - i);
    for (let b = 0;b < lim; b++) {
      const bit = word >>> b & 1;
      if (bit === 0)
        x[i + b] = -x[i + b];
    }
  }
  fastHadamardTransform(x);
}

// src/compression/rabitq.ts
function f32ToF16(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = x >>> 16 & 32768;
  let mant = x & 8388607;
  let exp = x >>> 23 & 255;
  if (exp === 255) {
    return sign | 31744 | (mant !== 0 ? 512 | mant >>> 13 : 0);
  }
  let newExp = exp - 127 + 15;
  if (newExp >= 31) {
    return sign | 31744;
  }
  if (newExp <= 0) {
    if (newExp < -10)
      return sign;
    mant = (mant | 8388608) >>> 1 - newExp;
    if ((mant & 4096) !== 0)
      mant += 8192;
    return sign | mant >>> 13;
  }
  if ((mant & 4096) !== 0) {
    mant += 8192;
    if ((mant & 8388608) !== 0) {
      mant = 0;
      newExp++;
      if (newExp >= 31)
        return sign | 31744;
    }
  }
  return sign | newExp << 10 | mant >>> 13;
}
function padToRotationDim(vec) {
  const out = new Float32Array(PADDED_DIM);
  const n = Math.min(vec.length, EMBED_DIM);
  for (let i = 0;i < n; i++)
    out[i] = vec[i];
  return out;
}
function l2Norm(vec) {
  let s = 0;
  for (let i = 0;i < vec.length; i++) {
    const v = vec[i];
    s += v * v;
  }
  return Math.sqrt(s);
}
function rotateUnit(vec) {
  const padded = padToRotationDim(vec);
  const norm = l2Norm(padded);
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0;i < PADDED_DIM; i++)
      padded[i] = padded[i] * inv;
  }
  rotateWithSeed(padded, ROTATION_SEED);
  return { rotated: padded, norm };
}
function packSigns(rotated) {
  const out = new Uint8Array(SIGN_BYTES);
  for (let i = 0;i < EMBED_DIM; i++) {
    if (rotated[i] >= 0) {
      const byteIdx = i >>> 3;
      const bitInByte = 7 - (i & 7);
      out[byteIdx] = out[byteIdx] | 1 << bitInByte;
    }
  }
  return out;
}
function rabitqEncode(vec) {
  const { rotated, norm } = rotateUnit(vec);
  const signs = packSigns(rotated);
  const invSqrtD = 1 / Math.sqrt(EMBED_DIM);
  let align = 0;
  for (let i = 0;i < EMBED_DIM; i++) {
    const r = rotated[i];
    align += r >= 0 ? r : -r;
  }
  align *= invSqrtD;
  return {
    signs,
    normFp16: f32ToF16(norm),
    alignFp16: f32ToF16(align)
  };
}
function packCode(code) {
  if (code.signs.length !== SIGN_BYTES) {
    throw new Error(`packCode: signs must be ${SIGN_BYTES} bytes, got ${code.signs.length}`);
  }
  const out = new Uint8Array(PACK_SIZE);
  out.set(code.signs, 0);
  out[NORM_OFFSET] = code.normFp16 & 255;
  out[NORM_OFFSET + 1] = code.normFp16 >>> 8 & 255;
  out[ALIGN_OFFSET] = code.alignFp16 & 255;
  out[ALIGN_OFFSET + 1] = code.alignFp16 >>> 8 & 255;
  out[CENTROID_OFFSET] = 0;
  out[CENTROID_OFFSET + 1] = 0;
  return out;
}
var EMBED_DIM = 1536, PADDED_DIM = 2048, SIGN_BYTES, ROTATION_SEED = "cortex.rabitq.rotation.v1", NORM_OFFSET, ALIGN_OFFSET, CENTROID_OFFSET, PACK_SIZE, f32, u32;
var init_rabitq = __esm(() => {
  SIGN_BYTES = EMBED_DIM >> 3;
  NORM_OFFSET = SIGN_BYTES;
  ALIGN_OFFSET = SIGN_BYTES + 2;
  CENTROID_OFFSET = SIGN_BYTES + 4;
  PACK_SIZE = SIGN_BYTES + 2 + 2 + 2;
  f32 = new Float32Array(1);
  u32 = new Uint32Array(f32.buffer);
});

// src/lib/events.ts
function publish(event) {
  seq += 1;
  const envelope = {
    id: String(seq),
    type: event.type,
    event
  };
  const ring = buffers.get(event.type) ?? [];
  ring.push(envelope);
  if (ring.length > RING_CAP_PER_TYPE)
    ring.shift();
  buffers.set(event.type, ring);
  dispatcher.dispatchEvent(new CustomEvent("evt", { detail: envelope }));
  return envelope;
}
var RING_CAP_PER_TYPE = 200, buffers, dispatcher, wrappedListeners, seq = 0;
var init_events = __esm(() => {
  buffers = new Map;
  dispatcher = new EventTarget;
  wrappedListeners = new Set;
});

// src/lib/cortex-config.ts
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "fs";
function configPath() {
  return process.env.CORTEX_CONFIG_PATH ?? join(homedir(), ".cortex", "config.json");
}
function readConfig() {
  if (_cached !== undefined)
    return _cached;
  const path = configPath();
  try {
    if (!existsSync(path)) {
      _cached = null;
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    _cached = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    _cached = null;
  }
  return _cached;
}
var _cached;
var init_cortex_config = () => {};

// src/compression/embeddings.ts
var exports_embeddings = {};
__export(exports_embeddings, {
  isUsableEmbeddingKey: () => isUsableEmbeddingKey,
  isMissingEmbeddingKey: () => isMissingEmbeddingKey,
  hasEmbeddingKey: () => hasEmbeddingKey,
  embedText: () => embedText,
  embedAndQuantize: () => embedAndQuantize,
  MissingEmbeddingKeyError: () => MissingEmbeddingKeyError,
  EMBEDDING_SETUP_MESSAGE: () => EMBEDDING_SETUP_MESSAGE
});
function isMissingEmbeddingKey(err) {
  return err instanceof MissingEmbeddingKeyError || typeof err === "object" && err !== null && "isMissingEmbeddingKey" in err;
}
function isUsableEmbeddingKey(key) {
  if (typeof key !== "string")
    return false;
  const v = key.trim();
  if (v.length < 16)
    return false;
  if (/\.{2,}|\u2026|placeholder|your[-_]?key/i.test(v))
    return false;
  return true;
}
function envEmbeddingKey(name) {
  const v = process.env[name];
  return isUsableEmbeddingKey(v) ? v.trim() : undefined;
}
function hasEmbeddingKey() {
  if (envEmbeddingKey("OPENAI_API_KEY") || envEmbeddingKey("OPENROUTER_API_KEY") || envEmbeddingKey("VOYAGE_API_KEY") || envEmbeddingKey("COHERE_API_KEY")) {
    return true;
  }
  const cfg = readConfig();
  return isUsableEmbeddingKey(cfg?.embeddingKey);
}
function toFloat32(arr, provider) {
  if (!Array.isArray(arr)) {
    throw new Error(`embedText: unexpected ${provider} response shape`);
  }
  if (arr.length !== EMBED_DIM2) {
    throw new Error(`embedText: expected ${EMBED_DIM2}-d from ${provider}, got ${arr.length}. ` + `RaBitQ requires exactly ${EMBED_DIM2}-d \u2014 set OPENROUTER_EMBED_MODEL to a 1536-d model.`);
  }
  const out = new Float32Array(EMBED_DIM2);
  for (let i = 0;i < EMBED_DIM2; i++)
    out[i] = arr[i];
  return out;
}
async function embedViaOpenAI(text, apiKey) {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [text],
      dimensions: EMBED_DIM2,
      encoding_format: "float"
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedText: OpenAI request failed ${res.status} ${res.statusText} \u2014 ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const first = json.data?.[0]?.embedding;
  return toFloat32(first, `OpenAI(${OPENAI_MODEL})`);
}
async function embedViaOpenRouter(text, apiKey) {
  const res = await fetch(OPENROUTER_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      input: [text],
      encoding_format: "float"
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedText: OpenRouter request failed ${res.status} ${res.statusText} \u2014 ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const first = json.data?.[0]?.embedding;
  return toFloat32(first, `OpenRouter(${OPENROUTER_MODEL})`);
}
async function embedViaVoyage(text, apiKey) {
  const res = await fetch(VOYAGE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: "document"
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedText: Voyage request failed ${res.status} ${res.statusText} \u2014 ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const first = json.data?.[0]?.embedding;
  return toFloat32(first, `Voyage(${VOYAGE_MODEL})`);
}
async function embedViaCohere(text, apiKey) {
  const res = await fetch(COHERE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: COHERE_MODEL,
      texts: [text],
      input_type: "search_document",
      embedding_types: ["float"],
      output_dimension: EMBED_DIM2
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedText: Cohere request failed ${res.status} ${res.statusText} \u2014 ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const first = json.embeddings?.float?.[0];
  return toFloat32(first, "Cohere");
}
async function embedText(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("embedText: input text must be a non-empty string");
  }
  const openAiKey = envEmbeddingKey("OPENAI_API_KEY");
  if (openAiKey)
    return embedViaOpenAI(text, openAiKey);
  const openRouterKey = envEmbeddingKey("OPENROUTER_API_KEY");
  if (openRouterKey)
    return embedViaOpenRouter(text, openRouterKey);
  const voyageKey = envEmbeddingKey("VOYAGE_API_KEY");
  if (voyageKey)
    return embedViaVoyage(text, voyageKey);
  const cohereKey = envEmbeddingKey("COHERE_API_KEY");
  if (cohereKey)
    return embedViaCohere(text, cohereKey);
  const cfg = readConfig();
  if (cfg?.embeddingKey && isUsableEmbeddingKey(cfg.embeddingKey)) {
    switch (cfg.embeddingProvider ?? "openai") {
      case "openrouter":
        return embedViaOpenRouter(text, cfg.embeddingKey);
      case "voyage":
        return embedViaVoyage(text, cfg.embeddingKey);
      case "cohere":
        return embedViaCohere(text, cfg.embeddingKey);
      case "openai":
      default:
        return embedViaOpenAI(text, cfg.embeddingKey);
    }
  }
  throw new MissingEmbeddingKeyError(EMBEDDING_SETUP_MESSAGE);
}
async function embedAndQuantize(text) {
  const rawEmbedding = await embedText(text);
  const t0 = performance.now();
  const code = rabitqEncode(rawEmbedding);
  const bytes = packCode(code);
  const ms = performance.now() - t0;
  publish({
    type: "rabitq.encoded",
    ts: Date.now(),
    dim: EMBED_DIM2,
    bytes: bytes.byteLength,
    ratio: EMBED_DIM2 * 4 / bytes.byteLength,
    ms
  });
  return { bytes, rawEmbedding };
}
var EMBED_DIM2 = 1536, EMBED_FETCH_TIMEOUT_MS = 30000, OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings", OPENAI_MODEL, OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings", OPENROUTER_MODEL, VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings", VOYAGE_MODEL, COHERE_EMBED_URL = "https://api.cohere.com/v2/embed", COHERE_MODEL = "embed-v4.0", MissingEmbeddingKeyError, EMBEDDING_SETUP_MESSAGE;
var init_embeddings = __esm(() => {
  init_rabitq();
  init_events();
  init_cortex_config();
  OPENAI_MODEL = process.env["OPENAI_EMBED_MODEL"] ?? "text-embedding-3-small";
  OPENROUTER_MODEL = process.env["OPENROUTER_EMBED_MODEL"] ?? "openai/text-embedding-3-small";
  VOYAGE_MODEL = process.env["VOYAGE_EMBED_MODEL"] ?? "voyage-large-2";
  MissingEmbeddingKeyError = class MissingEmbeddingKeyError extends Error {
    isMissingEmbeddingKey = true;
    constructor(message) {
      super(message);
      this.name = "MissingEmbeddingKeyError";
    }
  };
  EMBEDDING_SETUP_MESSAGE = [
    "Cortex needs an embedding API key to turn your notes into searchable memory.",
    "",
    "Add ONE of these to your environment (your shell profile, or a .env in your project):",
    "  \u2022 OPENAI_API_KEY=sk-\u2026        \u2190 get one at https://platform.openai.com/api-keys",
    "  \u2022 OPENROUTER_API_KEY=sk-or-\u2026 \u2190 or https://openrouter.ai/keys",
    "  \u2022 VOYAGE_API_KEY=\u2026           \u2190 Claude/Anthropic users: Anthropic has no embeddings",
    "                                 API, so use Voyage (their recommended partner):",
    "                                 https://dashboard.voyageai.com/",
    "  \u2022 COHERE_API_KEY=\u2026           \u2190 or https://dashboard.cohere.com/api-keys",
    "",
    "Then restart your session. (Your text is only sent to that provider to embed;",
    "the memory itself is encrypted with your wallet and stored on Arkiv.)"
  ].join(`
`);
});

// scripts/cortex-hook-capture.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { join as join2, basename } from "path";
import { homedir as homedir2 } from "os";
import { execFileSync, spawn } from "child_process";
var MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
var MAX_SUMMARY_CHARS = 6000;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
function resolveProject(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).toString().trim();
    const norm = normalizeRemote(url);
    if (norm)
      return norm;
  } catch {}
  try {
    return basename(cwd) || "unknown-project";
  } catch {
    return "unknown-project";
  }
}
function normalizeRemote(url) {
  if (!url)
    return null;
  let s = url.trim();
  s = s.replace(/\.git$/, "");
  const scp = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp)
    return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/^\/+/, "");
    if (u.hostname && path)
      return `${u.hostname}/${path}`;
  } catch {}
  return s || null;
}
function parseTranscript(raw) {
  const out = [];
  for (const line of raw.split(`
`)) {
    const t = line.trim();
    if (!t)
      continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = obj;
    const msg = rec.message ?? rec;
    const role = msg.role ?? rec.type;
    if (role !== "user" && role !== "assistant")
      continue;
    const text = extractText(msg.content);
    if (text)
      out.push({ role, text });
  }
  return out;
}
function extractText(content) {
  if (typeof content === "string")
    return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block;
        if (b.type === "text" && typeof b.text === "string")
          parts.push(b.text);
      }
    }
    return parts.join(`
`).trim();
  }
  return "";
}
var DECISION_CUES = /\b(decided|chose|chosen|will use|going with|approach|because|instead of|root cause|fix(?:ed)?|implement(?:ed)?|the plan|next step|conclusion|trade-?off|settled on)\b/i;
function buildSummary(msgs, project, sessionId) {
  const userTurns = msgs.filter((m) => m.role === "user");
  const asstTurns = msgs.filter((m) => m.role === "assistant");
  const goals = dedupeShort(userTurns.map((m) => firstMeaningfulLine(m.text)).filter((s) => Boolean(s)), 8);
  const decisionLines = [];
  for (const m of asstTurns) {
    for (const line of m.text.split(`
`)) {
      const s = line.trim();
      if (s.length < 12)
        continue;
      if (DECISION_CUES.test(s))
        decisionLines.push(s);
    }
  }
  let decisions = dedupeShort(decisionLines, 12);
  if (decisions.length === 0) {
    decisions = dedupeShort(asstTurns.map((m) => firstMeaningfulLine(m.text)).filter((s) => Boolean(s)), 8);
  }
  const lines = [];
  lines.push(`# Session ${sessionId} \u2014 ${project}`);
  lines.push("");
  lines.push(`Captured ${new Date().toISOString()} \xB7 ${userTurns.length} user / ${asstTurns.length} assistant turns.`);
  lines.push("");
  lines.push("## Goals (what the user asked)");
  if (goals.length)
    for (const g of goals)
      lines.push(`- ${g}`);
  else
    lines.push("- (no clear user goals extracted)");
  lines.push("");
  lines.push("## Decisions & outcomes (what the assistant did)");
  if (decisions.length)
    for (const d of decisions)
      lines.push(`- ${d}`);
  else
    lines.push("- (no clear decisions extracted)");
  let summary = lines.join(`
`);
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS) + `
\u2026(truncated)`;
  }
  return summary;
}
function firstMeaningfulLine(text) {
  for (const raw of text.split(`
`)) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (!s || s.startsWith("/") || s.startsWith("```") || s.startsWith("<"))
      continue;
    if (s.length < 4)
      continue;
    return s.length > 240 ? s.slice(0, 240) + "\u2026" : s;
  }
  return null;
}
function dedupeShort(items, limit) {
  const seen = new Set;
  const out = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit)
      break;
  }
  return out;
}
function dataDir() {
  const base = process.env.CORTEX_PLUGIN_DATA_DIR ?? join2(homedir2(), ".cortex", "plugin");
  const pending = join2(base, "pending");
  mkdirSync2(pending, { recursive: true });
  return pending;
}
function queuePending(p) {
  const dir = dataDir();
  const file = join2(dir, `${safeName(p.project)}__${safeName(p.sessionId)}.json`);
  writeFileSync2(file, JSON.stringify(p, null, 2), "utf-8");
  return file;
}
function safeName(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "x";
}
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("cortex-capture timeout")), ms))
  ]);
}
async function main() {
  let event = {};
  try {
    const stdin = await withTimeout(readStdin(), 2000);
    if (stdin.trim())
      event = JSON.parse(stdin);
  } catch (err) {
    log("could not read/parse stdin event:", err);
    return;
  }
  const cwd = event.cwd || process.cwd();
  const sessionId = event.session_id || `nosession-${Date.now()}`;
  const eventName = event.hook_event_name || "unknown";
  const project = resolveProject(cwd);
  const title = `Session summary \u2014 ${eventName} \u2014 ${sessionId}`;
  let summary = "";
  try {
    const path = event.transcript_path;
    if (path && existsSync2(path)) {
      let raw = readFileSync2(path, "utf-8");
      if (raw.length > MAX_TRANSCRIPT_BYTES)
        raw = raw.slice(-MAX_TRANSCRIPT_BYTES);
      const msgs = parseTranscript(raw);
      summary = buildSummary(msgs, project, sessionId);
    } else {
      log(`transcript_path missing or not found: ${path}`);
    }
  } catch (err) {
    log("transcript parse failed:", err);
  }
  if (!summary.trim()) {
    log(`no summary produced for project=${project} session=${sessionId}; nothing to capture.`);
    return;
  }
  const file = queuePending({
    summary,
    sessionId,
    project,
    title,
    queuedAt: new Date().toISOString(),
    reason: "queued for background drain",
    event: eventName
  });
  log(`queued session summary: ${file} (project=${project} session=${sessionId})`);
  try {
    const { hasEmbeddingKey: hasEmbeddingKey2, EMBEDDING_SETUP_MESSAGE: EMBEDDING_SETUP_MESSAGE2 } = await Promise.resolve().then(() => (init_embeddings(), exports_embeddings));
    if (!hasEmbeddingKey2()) {
      log(`
Cortex: session memory queued, but not yet synced to Arkiv.
${EMBEDDING_SETUP_MESSAGE2}
`);
      return;
    }
  } catch {}
  spawnDetachedDrain(project);
}
function spawnDetachedDrain(project) {
  try {
    const here = import.meta.dir;
    const bundled = join2(here, "cortex-drain.js");
    const drainScript = existsSync2(bundled) ? bundled : join2(here, "cortex-drain.ts");
    const child = spawn("bun", [drainScript, project], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch (err) {
    log("could not spawn background drainer (summary stays queued for next session):", err);
  }
}
function log(...args) {
  console.error("[cortex/capture]", ...args);
}
main().catch((err) => log("unexpected error (ignored):", err)).finally(() => process.exit(0));
