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
  // §13.10 budgets 60 ms for a query embedding on a cache miss. 800 ms is the
  // point past which the request has already blown its p95 and waiting longer
  // only makes the failure slower.
  //
  // Configurable for the same reason as the other two: an evaluation must not
  // inherit production's soft failure. Measured here, bge-m3 on CPU answers a
  // query in ~222 ms median / 258 ms max once warm — inside the cap, but nowhere
  // near §13.10's 60 ms — and the FIRST call after the model has been idle can
  // exceed 800 ms outright. In production that degrades to lexical-only for one
  // request, which is correct. In a measurement it silently removes the semantic
  // arm from the run.
  embedQuery: Number(process.env.EMBED_QUERY_TIMEOUT_MS ?? 800),
  // §13.10 budgets 180 ms for rerank across both zones and makes it the first
  // thing to drop under load, so 2 s in production is already generous.
  //
  // Configurable because an EVALUATION must not inherit that. Measured here, 50
  // realistic documents cost 2,550 ms on the MiniLM stand-in and 8,375 ms on
  // bge-m3 — both over the cap. In production dropping the rerank is correct
  // behaviour; in a measurement it means some queries rerank and some silently
  // do not, which is noise the comparison then attributes to the model.
  rerank: Number(process.env.RERANK_TIMEOUT_MS ?? 2_000),
  // Ingest-time, so no request is waiting on it -- but it is NOT unbounded,
  // because an abort here is what stops a slow provider from being retried into
  // the ground. That happened: a 30 s cap against a CPU ONNX bge-m3 aborted every
  // batch, and because an aborted fetch does not cancel the server's work, three
  // retries per batch queued 15,348 requests onto a single-threaded model until it
  // stopped answering anything at all. 0 chunks embedded, 5,644 marked failed.
  //
  // So it is configurable rather than generous: the value must match the provider
  // actually in use. Measured on this machine, a 500-word chunk costs ~2.8 s on
  // bge-m3 int8, which puts a batch of 8 at ~24 s and a batch of 16 at ~43 s.
  embedBatch: Number(process.env.EMBED_BATCH_TIMEOUT_MS ?? 30_000),
  classify: 15_000,
};

async function call(path, body, timeoutMs, baseUrl = env.inferenceUrl) {
  if (!baseUrl) throw new Error('INFERENCE_API_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
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
    }, TIMEOUTS.rerank, env.rerankUrl);
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
