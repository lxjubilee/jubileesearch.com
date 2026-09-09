// Jubilee Inference API client.
//
// §16: "Sole provider of embeddings, reranking, and safety classification.
// JubileeSearch runs no models of its own." So every model call in the engine
// goes through this file, and there is exactly one place to change when the
// Inference API's contract moves.
//
// The card behind this API also serves persona traffic and JSV work (§16, and
// the last row of the risk register). Two things follow, and both are
// implemented here rather than left to callers:
//
//   * Search embedding jobs run at low queue priority in an off-peak window.
//     The `priority` argument carries that; publish-push is the one exception
//     and passes priority 1 (§12.2).
//   * Every call degrades rather than throws. A search that cannot embed its
//     query is a lexical-only search, which is worse than a hybrid one and far
//     better than a 500. Only ingest-time embedding surfaces failures, because
//     there the work must be retried rather than skipped.

import { env } from '../config.js';

const TIMEOUTS = {
  // §13.10 budgets 60 ms for a query embedding on a cache miss. 800 ms is the
  // point past which the request has already blown its p95 and waiting longer
  // only makes the failure slower.
  embedQuery: 800,
  rerank: 2_000,
  embedBatch: 30_000,
  classify: 15_000,
};

async function call(path, body, timeoutMs) {
  if (!env.inferenceUrl) throw new Error('INFERENCE_API_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.inferenceUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.inferenceKey ? { authorization: `Bearer ${env.inferenceKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`inference ${path} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed one query. Returns null on any failure -- see the degradation note above.
 * Callers must treat null as "no vector path this time", not as an error.
 */
export async function embedQuery(text) {
  try {
    const json = await call('/v1/embeddings', {
      model: env.embeddingModel,
      input: [text],
      priority: 'realtime',
    }, TIMEOUTS.embedQuery);
    const vector = json?.data?.[0]?.embedding ?? json?.embeddings?.[0] ?? null;
    return Array.isArray(vector) && vector.length ? vector : null;
  } catch (err) {
    warn('embedQuery', err);
    return null;
  }
}

/**
 * Embed a batch of chunks for ingest. Throws, deliberately: §12.2 requires
 * retry with backoff and, after three failures, marking the chunk for manual
 * inspection "rather than silently dropping it".
 *
 * @param {string[]} texts   32 to 64 per call (§12.2)
 * @param {number} priority  1 for publish-push, 100 for the nightly backfill
 */
export async function embedBatch(texts, priority = 100) {
  const json = await call('/v1/embeddings', {
    model: env.embeddingModel,
    input: texts,
    priority: priority === 1 ? 'realtime' : 'batch',
  }, TIMEOUTS.embedBatch);
  const vectors = json?.data?.map((d) => d.embedding) ?? json?.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`inference returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  return vectors;
}

/**
 * Cross-encoder rerank of one zone's candidates (§6.1, top 50 per zone).
 * Returns the input order unchanged on failure -- fusion order is a reasonable
 * answer, and §13.10 already treats rerank as the thing to drop under load.
 */
export async function rerank(query, documents) {
  if (documents.length === 0) return { order: [], reranked: false };
  try {
    const json = await call('/v1/rerank', {
      model: env.rerankModel,
      query,
      documents,
      priority: 'realtime',
    }, TIMEOUTS.rerank);
    const results = json?.results ?? json?.data;
    if (!Array.isArray(results)) throw new Error('rerank returned no results array');
    const order = results
      .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
      .sort((a, b) => b.score - a.score);
    return { order, reranked: true };
  } catch (err) {
    warn('rerank', err);
    return { order: documents.map((_, index) => ({ index, score: null })), reranked: false };
  }
}

/**
 * Gate 3 content classification (§11.1). "Output is structured JSON, never free
 * prose." A malformed or missing response is not treated as safe -- P1 is
 * default deny, and an unreachable classifier means the page stays in T0.
 */
export async function classifyContent(text) {
  try {
    const json = await call('/v1/classify/family-safety', {
      model: env.safetyModel || undefined,
      text: text.slice(0, 20_000),
      priority: 'batch',
    }, TIMEOUTS.classify);
    if (typeof json?.safe_for_family !== 'boolean' || typeof json?.confidence !== 'number') {
      throw new Error('classifier response missing safe_for_family/confidence');
    }
    return {
      safe_for_family: json.safe_for_family,
      confidence: json.confidence,
      categories: json.categories ?? [],
      flags: json.flags ?? [],
      reason: json.reason ?? '',
    };
  } catch (err) {
    warn('classifyContent', err);
    return null;   // caller holds the page in T0
  }
}

/**
 * Whether this engine can reach a model at all, for /health.
 *
 * Without it the absence of an Inference API is invisible: `embedQuery` returns
 * null by design, retrieval quietly drops to its lexical arm, and the only
 * symptom is that queries which share no words with a page find nothing. That
 * looks exactly like a broken search and is nothing of the kind, so health says
 * which mode the engine is actually in.
 *
 * Deliberately no URL and no key: /health is unauthenticated (§14), and the
 * address of an internal service is not something to hand out at the door.
 */
export function inferenceStatus() {
  const configured = Boolean(env.inferenceUrl);
  return {
    configured,
    // The one field worth reading. 'lexical-only' means no semantic matching:
    // every result comes from word overlap alone.
    search_mode: configured ? 'hybrid' : 'lexical-only',
    embedding_model: env.embeddingModel,
  };
}

function warn(op, err) {
  console.warn(JSON.stringify({ level: 'warn', at: `inference.${op}`, msg: err.message }));
}
