#!/usr/bin/env node
// Preflight for the Jubilee Inference API (§16).
//
// Why this exists: a wrong or absent INFERENCE_API_URL produces no error
// anywhere. `embedQuery` returns null by design so a search degrades to its
// lexical arm instead of 500ing (see src/inference/client.js), and `embedBatch`
// throws into a retry loop that gives up quietly after three attempts. The only
// symptom is that queries sharing no words with a page find nothing -- which
// reads as a broken search engine and is nothing of the kind.
//
// So before trusting a URL, check it against the contract the engine actually
// depends on:
//
//   POST /v1/embeddings            {model, input: string[], priority}
//                                  -> {data: [{embedding: number[]}]}  (or {embeddings})
//   POST /v1/rerank                {model, query, documents, priority}
//                                  -> {results: [{index, relevance_score}]}
//   POST /v1/classify/family-safety {model, text, priority}
//                                  -> {safe_for_family: bool, confidence: number}
//
// The dimension check is the one that matters most. `chunks.embedding` is
// halfvec(1024) (002_core.sql) and the HNSW indexes are built on it, so a model
// returning 768 or 1536 does not degrade -- every single insert fails.
//
// Usage:
//   INFERENCE_API_URL=https://... INFERENCE_API_KEY=... node bin/inference-check.mjs
//   npm run inference:check
//
// Exits non-zero if the endpoint cannot serve the engine, so it can gate a deploy.

import { env } from '../src/config.js';

const DIM = 1024;          // halfvec(1024) -- must match 002_core.sql
const PASS = '  PASS ';
const FAIL = '  FAIL ';
const WARN = '  WARN ';

let failures = 0;
let warnings = 0;

function pass(what, detail = '') { console.log(PASS + what + (detail ? '  ' + detail : '')); }
function fail(what, detail = '') { failures += 1; console.log(FAIL + what + (detail ? '  ' + detail : '')); }
function warn(what, detail = '') { warnings += 1; console.log(WARN + what + (detail ? '  ' + detail : '')); }

if (!env.inferenceUrl) {
  console.error(
`INFERENCE_API_URL is not set.

The engine runs, indexes and searches without it -- but lexically only. No
chunk is ever embedded, so a query that shares no words with a page returns
nothing at all. /api/v1/health reports this as:

    "inference": { "configured": false, "search_mode": "lexical-only" }

Set it in engine/.env and run this again:

    INFERENCE_API_URL=https://<host>   the base URL; paths are appended to it
    INFERENCE_API_KEY=<key>            sent as: authorization: Bearer <key>
`);
  process.exit(2);
}

const base = env.inferenceUrl.replace(/\/$/, '');
console.log(`\nChecking ${base}`);
console.log(`  embedding model: ${env.embeddingModel}`);
console.log(`  rerank model:    ${env.rerankModel}`);
console.log(`  api key:         ${env.inferenceKey ? 'set' : 'NOT SET'}\n`);

async function post(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.inferenceKey ? { authorization: `Bearer ${env.inferenceKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported by the caller */ }
    return { ok: res.ok, status: res.status, json, text, ms };
  } finally {
    clearTimeout(timer);
  }
}

// --- 1. embeddings -----------------------------------------------------------
// Two inputs, not one: a service that ignores batching and always returns a
// single vector passes a one-input test and then breaks the ingest job, which
// sends 48 at a time.
const inputs = ['the shepherd leads his flock', 'a crawler must not overload a host'];
let vectors = null;

try {
  const r = await post('/v1/embeddings',
    { model: env.embeddingModel, input: inputs, priority: 'batch' }, 30_000);

  if (!r.ok) {
    fail('POST /v1/embeddings', `HTTP ${r.status}: ${r.text.slice(0, 160)}`);
  } else if (!r.json) {
    fail('POST /v1/embeddings', 'response was not JSON');
  } else {
    vectors = r.json?.data?.map((d) => d.embedding) ?? r.json?.embeddings ?? null;
    if (!Array.isArray(vectors)) {
      fail('embeddings response shape',
        'expected data[].embedding or embeddings[]; got keys: ' + Object.keys(r.json).join(', '));
      vectors = null;
    } else if (vectors.length !== inputs.length) {
      fail('batching', `sent ${inputs.length} inputs, got ${vectors.length} vectors`);
      vectors = null;
    } else {
      pass('POST /v1/embeddings', `${r.ms} ms for ${inputs.length} inputs`);
    }
  }
} catch (err) {
  fail('POST /v1/embeddings', err.name === 'AbortError' ? 'timed out after 30s' : err.message);
}

// --- 2. the dimension, which must match the column exactly -------------------
if (vectors) {
  const dims = [...new Set(vectors.map((v) => (Array.isArray(v) ? v.length : -1)))];
  if (dims.length !== 1) {
    fail('dimension', `inconsistent across the batch: ${dims.join(', ')}`);
  } else if (dims[0] !== DIM) {
    fail('dimension',
      `model returns ${dims[0]}, but chunks.embedding is halfvec(${DIM}). Every ` +
      'insert will fail. Use a 1024-dimension model (bge-m3), or migrate the ' +
      'column and both HNSW indexes together.');
  } else {
    pass('dimension', `${DIM}, matches chunks.embedding`);
  }

  const finite = vectors.every((v) => v.every((n) => Number.isFinite(n)));
  if (!finite) fail('vector values', 'contains NaN or Infinity');
  else pass('vector values', 'all finite');

  // Cosine distance is meaningless if every vector is identical, and a stub
  // that returns zeros or a constant will otherwise sail through every check
  // above while making search silently useless.
  const [a, b] = vectors;
  const dot = a.reduce((acc, n, i) => acc + n * b[i], 0);
  const mag = (v) => Math.sqrt(v.reduce((acc, n) => acc + n * n, 0));
  const magA = mag(a);
  const magB = mag(b);
  if (magA === 0 || magB === 0) {
    fail('vectors are non-degenerate', 'a zero vector has no direction; cosine distance is undefined');
  } else {
    const cos = dot / (magA * magB);
    if (cos > 0.999) {
      fail('vectors are non-degenerate',
        `two unrelated sentences scored cosine ${cos.toFixed(4)} -- the service is ` +
        'returning effectively the same vector for every input');
    } else {
      pass('vectors are non-degenerate', `cosine between two unrelated inputs: ${cos.toFixed(3)}`);
    }
  }
}

// --- 3. rerank (optional: retrieval falls back to fusion order) --------------
try {
  const r = await post('/v1/rerank', {
    model: env.rerankModel,
    query: 'crawler politeness',
    documents: ['how to avoid overloading a host', 'a psalm of ascent'],
    priority: 'realtime',
  }, 10_000);

  if (!r.ok) {
    warn('POST /v1/rerank', `HTTP ${r.status} -- results keep fusion order (§13.10)`);
  } else {
    const results = r.json?.results ?? r.json?.data;
    if (!Array.isArray(results)) warn('rerank response shape', 'no results[] array');
    else if (!results.every((x) => typeof x.index === 'number')) {
      warn('rerank response shape', 'results[] entries need a numeric index');
    } else pass('POST /v1/rerank', `${r.ms} ms`);
  }
} catch (err) {
  warn('POST /v1/rerank', err.name === 'AbortError' ? 'timed out' : err.message);
}

// --- 4. safety classification (gate 3) ---------------------------------------
// Not optional in effect: P1 is default deny, so an unreachable classifier
// leaves every crawled page stuck in T0 and Zone B stays empty forever.
try {
  const r = await post('/v1/classify/family-safety', {
    model: env.safetyModel || undefined,
    text: 'A short devotional about patience.',
    priority: 'batch',
  }, 20_000);

  if (!r.ok) {
    fail('POST /v1/classify/family-safety',
      `HTTP ${r.status} -- gate 3 cannot run, so every crawled page stays in T0 (P1 default deny)`);
  } else if (typeof r.json?.safe_for_family !== 'boolean' || typeof r.json?.confidence !== 'number') {
    fail('classify response shape', 'needs {safe_for_family: boolean, confidence: number}');
  } else {
    pass('POST /v1/classify/family-safety', `${r.ms} ms`);
  }
} catch (err) {
  fail('POST /v1/classify/family-safety',
    err.name === 'AbortError' ? 'timed out after 20s' : err.message);
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed${warnings ? `, ${warnings} warning(s)` : ''}.`);
  console.log('The engine will not embed correctly against this endpoint.');
  process.exit(1);
}
console.log(`All checks passed${warnings ? ` (${warnings} warning(s))` : ''}.`);
console.log('\nNext: work off the embedding backlog, then rebuild the query cache.');
console.log('    node src/jobs/embed.js');
console.log('    curl -s localhost:4038/api/v1/health   # embedded_chunks should climb\n');
