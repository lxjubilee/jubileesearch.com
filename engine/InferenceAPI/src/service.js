// The service: what each endpoint means, independent of HTTP.
//
// Kept separate from server.js so the behaviour can be tested without a socket,
// and so a future transport (gRPC, a queue consumer) does not require the logic
// to be rewritten or, worse, duplicated.

import { env } from './config.js';
import { log, budget } from './log.js';
import * as models from './models.js';
import { InferenceQueue, priorityOf, PRIORITY } from './queue.js';

// One queue per role. Roles do not share a queue because they do not share a
// model: a rerank waiting behind an embedding batch would be queued on hardware
// that is not even busy with its own work.
const queues = new Map();

function queueFor(role, run) {
  if (!queues.has(role)) {
    queues.set(role, new InferenceQueue({ run, name: role, maxBatch: env.maxBatch }));
  }
  return queues.get(role);
}

// ---------------------------------------------------------------------------

/**
 * Embed texts. §12.2 asks callers for 32-64 per call; this coalesces across
 * callers up to MAX_BATCH, which is a property of the hardware rather than of
 * the spec.
 */
export async function embed({ input, priority } = {}) {
  const texts = Array.isArray(input) ? input : [String(input ?? '')];
  if (texts.length === 0) { const e = new Error('input is required'); e.status = 400; throw e; }
  if (texts.some((t) => typeof t !== 'string' && typeof t !== 'number')) {
    const e = new Error('input must be a string or an array of strings'); e.status = 400; throw e;
  }

  const prio = priorityOf(priority);
  const q = queueFor('embed', async (batch) => {
    const model = await models.get('embed');
    return model.embed(batch);
  });

  const t0 = performance.now();
  const vectors = await Promise.all(texts.map((t) => q.submit(String(t), prio)));
  const ms = performance.now() - t0;

  // A single realtime item is a query embedding on a cache miss, which is the
  // thing §13.10 budgets 60 ms for. A bulk batch of 64 is not, and warning about
  // it would be noise.
  if (prio <= PRIORITY.realtime && texts.length === 1) {
    budget('inference.embed', ms, env.budgets.embedQueryMs, { model: env.models.embed.id });
  }

  const spec = env.models.embed;
  return {
    model: spec.id,
    dimensions: spec.dim,
    took_ms: Math.round(ms),
    data: vectors.map((embedding, index) => ({ index, embedding })),
  };
}

/**
 * Rerank documents against a query.
 *
 * The ORDERING is decided here, not in the backend, so that every backend
 * returns comparable scores and the sort happens once. `reranked: true` says the
 * order was computed rather than passed through — a caller that must know
 * whether the stage actually ran should read it rather than infer from timing.
 */
export async function rerank({ query, documents, priority } = {}) {
  const docs = (Array.isArray(documents) ? documents : [])
    .map((d) => (typeof d === 'string' ? d : d?.text ?? ''));
  if (docs.length === 0) {
    return { model: env.models.rerank.id || null, results: [], reranked: false, took_ms: 0 };
  }
  if (!env.models.rerank.repo) {
    const e = new Error('no rerank model is configured (RERANK_MODEL_REPO is unset)');
    e.status = 501; throw e;
  }

  const prio = priorityOf(priority ?? 'realtime');
  const q = queueFor('rerank', async (batch) => {
    const model = await models.get('rerank');
    // Each queue item is one whole (query, documents) job: the pairs inside it
    // must be scored together, and splitting them across batches would reorder
    // against different neighbours.
    return Promise.all(batch.map((job) => model.scorePairs(job.query, job.docs)));
  });

  const t0 = performance.now();
  const scores = await q.submit({ query: String(query ?? ''), docs }, prio);
  const ms = performance.now() - t0;
  budget('inference.rerank', ms, env.budgets.rerankMs, {
    model: env.models.rerank.id, documents: docs.length, kind: env.models.rerank.kind,
  });

  const results = scores
    .map((relevance_score, index) => ({ index, relevance_score }))
    .sort((a, b) => b.relevance_score - a.relevance_score);

  return {
    model: env.models.rerank.id,
    kind: env.models.rerank.kind,
    reranked: true,
    took_ms: Math.round(ms),
    results,
  };
}

/**
 * Family-safety classification. THE SLOT EXISTS; NOTHING FILLS IT.
 *
 * This returns 501 and will keep returning 501 until a real classifier is
 * configured. That is a deliberate refusal, not an oversight:
 *
 * Safety Gate 3 decides whether an external page may enter Zone B. A keyword
 * list in this position would admit unsafe pages while reporting that it had
 * checked them — worse than no gate, because P1's default-deny holds only while
 * this endpoint is honest about not knowing. With no classifier every crawled
 * page stays in T0, Zone B stays empty, and nothing unsafe is ever shown.
 *
 * Implementing this means configuring SAFETY_MODEL_REPO with a real model and
 * writing the backend path. It does not mean making this function return
 * `{ safe_for_family: true }`.
 */
export async function classifySafety({ text, priority } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    const e = new Error('text is required'); e.status = 400; throw e;
  }
  const spec = env.models.safety;
  if (!spec.repo || !spec.topicRepo) {
    // Refuse rather than approximate. With this unconfigured, P1 default-deny
    // holds on the search side and every crawled page stays in T0.
    const e = new Error(
      'family-safety classification is not configured: set SAFETY_MODEL_REPO (toxicity) '
      + 'and SAFETY_TOPIC_MODEL_REPO (zero-shot topics). Safety Gate 3 requires both.');
    e.status = 501;
    e.code = 'safety_classifier_not_configured';
    throw e;
  }
  // Pages are classified at batch priority by default: a crawl must never sit
  // ahead of a search on the same GPU.
  const prio = priorityOf(priority ?? 'bulk');
  const q = queueFor('safety', async (batch) => {
    const model = await models.get('safety');
    return model.classify(batch);
  });
  const t0 = performance.now();
  const raw = await q.submit(text, prio);
  const ms = performance.now() - t0;
  budget('inference.classify', ms, env.budgets.classifyMs, { model: spec.id });
  const { verdict } = await import('./safety.js');
  return {
    model: spec.id,
    took_ms: Math.round(ms),
    ...verdict(raw.toxic, raw.topics, { unsafeTopicThreshold: spec.unsafeTopicThreshold }),
  };
}

// ---------------------------------------------------------------------------

export function health() {
  const m = models.state();
  const rss = process.memoryUsage().rss;
  return {
    status: 'ok',
    ready: models.ready(),
    service: 'jubilee-inference-api',
    spec: '16',
    ...m,
    queues: Object.fromEntries([...queues].map(([role, q]) => [role, {
      depth: q.depth, ...q.stats,
    }])),
    budgets_ms: env.budgets,
    batching: { max: env.maxBatch, wait_ms: env.batchWaitMs, max_queue_depth: env.maxQueueDepth },
    memory: { rss_mb: Math.round(rss / 1048576) },
    uptime_s: Math.round(process.uptime()),
  };
}

export { models, log };
