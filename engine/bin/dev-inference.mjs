#!/usr/bin/env node
/**
 * A stand-in Jubilee Inference API for development, running a REAL model.
 *
 *   node bin/dev-inference.mjs        # :4032
 *
 * §16 makes the Jubilee Inference API "the sole provider of embeddings,
 * reranking, and safety classification. JubileeSearch runs no models of its
 * own." That is still true of the engine: this is a separate service speaking
 * the same HTTP contract, exactly as bin/dev-sso.mjs stands in for the Jubilee
 * ID authority. Nothing in src/ gained a model.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS NOT. Read this before trusting a result.
 * ---------------------------------------------------------------------------
 *
 * REAL — embeddings. `all-MiniLM-L6-v2` is a genuine sentence-transformer, so
 * "why do I feel far from God" and "restoring a distant relationship with God"
 * land near each other because the model understands them, not because they
 * share words. This is what makes the semantic arm of the hybrid search
 * actually retrieve.
 *
 * REAL, BUT NOT THE SAME SHAPE — reranking. §6.1 specifies a cross-encoder
 * (bge-reranker-v2-m3), which scores the query and document *together*. This
 * reranks by cosine similarity between the query embedding and each document's
 * embedding, which is a bi-encoder. It genuinely reorders on relevance and it
 * genuinely executes, but it is weaker than a cross-encoder and must not be
 * reported as one.
 *
 * NOT IMPLEMENTED — safety classification. Gate 3 decides whether open-web
 * content is family-safe, and a keyword list dressed up as a classifier is
 * worse than nothing: it would let unsafe pages into Zone B while looking like
 * a control. This returns 503, so P1 default-deny holds and crawled pages stay
 * in T0. Zone B ingestion needs the real Inference API.
 *
 * ---------------------------------------------------------------------------
 * THE DIMENSION, AND WHY PADDING IS SOUND
 * ---------------------------------------------------------------------------
 * `chunks.embedding` is halfvec(1024) for bge-m3. MiniLM returns 384. The
 * vectors are zero-padded to 1024, which leaves cosine distance EXACTLY
 * unchanged: the dot product gains nothing from zero components and neither
 * magnitude does, so cos(a,b) is identical before and after. The HNSW index is
 * built on halfvec_cosine_ops, so it is unaffected too.
 *
 * What padding does NOT do is make these bge-m3 vectors. They are stored with
 * model_id 'dev-minilm-l6-v2@padded1024', so when the real Inference API
 * arrives every chunk it wrote is identifiable and must be re-embedded:
 *
 *     UPDATE chunks SET embedding = NULL, embedded_at = NULL
 *      WHERE model_id = 'dev-minilm-l6-v2@padded1024';
 *     npm run embed
 */

import { createServer } from 'node:http';

if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error(`dev-inference.mjs refuses to run with NODE_ENV=${process.env.NODE_ENV}.`);
  process.exit(1);
}

const PORT = Number(process.env.INFERENCE_PORT ?? 4032);
const TARGET_DIM = 1024;              // halfvec(1024), from 002_core.sql
const MODEL_ID = 'dev-minilm-l6-v2@padded1024';

console.log('Loading the embedding model (first run downloads ~25MB)…');
const { pipeline } = await import('@huggingface/transformers');
const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
console.log('Model ready.');

/** Mean-pooled, L2-normalised, then zero-padded to the column's width. */
async function embedAll(texts) {
  const out = await embed(texts, { pooling: 'mean', normalize: true });
  const [rows, dim] = out.dims;
  const data = out.data;
  const vectors = [];
  for (let r = 0; r < rows; r += 1) {
    const v = new Array(TARGET_DIM).fill(0);
    for (let i = 0; i < dim && i < TARGET_DIM; i += 1) v[i] = data[r * dim + i];
    vectors.push(v);
  }
  return vectors;
}

const cosine = (a, b) => {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return (ma && mb) ? dot / Math.sqrt(ma * mb) : 0;
};

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }

    try {
      if (req.url === '/v1/embeddings') {
        const input = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
        if (input.length === 0) return send(res, 400, { error: 'input is required' });
        const vectors = await embedAll(input.map((t) => String(t ?? '').slice(0, 8000)));
        return send(res, 200, {
          model: MODEL_ID,
          data: vectors.map((embedding, index) => ({ index, embedding })),
        });
      }

      if (req.url === '/v1/rerank') {
        const documents = Array.isArray(body.documents) ? body.documents : [];
        if (documents.length === 0) return send(res, 200, { results: [] });
        const [q, ...docs] = await embedAll([
          String(body.query ?? ''),
          ...documents.map((d) => String(typeof d === 'string' ? d : d?.text ?? '').slice(0, 8000)),
        ]);
        const results = docs
          .map((d, index) => ({ index, relevance_score: cosine(q, d) }))
          .sort((a, b) => b.relevance_score - a.relevance_score);
        return send(res, 200, { model: MODEL_ID, results });
      }

      if (req.url === '/v1/classify/family-safety') {
        // Deliberately not implemented. See the header: a keyword list that
        // answers this question is a control that does not control anything.
        return send(res, 503, {
          error: 'the development inference stand-in does not classify safety; '
               + 'gate 3 needs the real Jubilee Inference API',
        });
      }

      return send(res, 404, { error: `no route for ${req.url}` });
    } catch (err) {
      console.error('[dev-inference]', err.message);
      return send(res, 500, { error: err.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`
Development inference stand-in on http://127.0.0.1:${PORT}

  POST /v1/embeddings              REAL  all-MiniLM-L6-v2, 384 dims zero-padded to ${TARGET_DIM}
  POST /v1/rerank                  REAL  bi-encoder cosine, NOT the specified cross-encoder
  POST /v1/classify/family-safety  503   gate 3 needs the real API (P1 default deny holds)

  engine/.env    INFERENCE_API_URL=http://127.0.0.1:${PORT}

Vectors are written with model_id '${MODEL_ID}'.
Re-embed everything when the real Inference API is available.
`);
});
