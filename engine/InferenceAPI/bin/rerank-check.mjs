// Load a cross-encoder the way the service does and score a few pairs.
//
//   node bin/rerank-check.mjs bge-reranker-v2-m3            # local export (models/)
//   node bin/rerank-check.mjs Xenova/bge-reranker-base      # Hub model
//
// Reads INFERENCE_DEVICE / INFERENCE_DML_DEVICE_ID / RERANK_DTYPE from .env
// like the service, so it exercises the same path. Prints per-pair logits and
// the time for one 20-document batch after a warm-up.

import { env } from '../src/config.js';

const repo = process.argv[2] || env.models.rerank.repo;
const dtype = process.argv[3] || env.models.rerank.dtype || 'fp16';
const tf = await import('@huggingface/transformers');
tf.env.allowLocalModels = true;
tf.env.localModelPath = env.localModelPath;

const opts = { dtype };
if (env.device && env.device !== 'cpu') {
  opts.device = env.device;
  if (env.device === 'dml' && env.dmlDeviceId !== null) {
    opts.session_options = { executionProviders: [{ name: 'dml', deviceId: env.dmlDeviceId }] };
  }
}

const t0 = performance.now();
const tokenizer = await tf.AutoTokenizer.from_pretrained(repo);
const model = await tf.AutoModelForSequenceClassification.from_pretrained(repo, opts);
console.log(`${repo} (${dtype}, ${env.device}) loaded in ${Math.round(performance.now() - t0)} ms`);

const query = 'how do I return to God after failing';
const docs = [
  'Teshuvah is the turning and returning to God after sin; repentance is never finished in one sitting.',
  'Shabbat rest and the calendar of feasts, kept rather than taken.',
  'The priesthood of believers and the order of service.',
  'Pocăința este întoarcerea la Dumnezeu; Duhul Sfânt ne dă har să iertăm.',
  'Best pizza recipe with a crisp base and fresh basil.',
];
const score = async (q, ds) => {
  const inputs = tokenizer(new Array(ds.length).fill(q), { text_pair: ds, padding: true, truncation: true });
  const { logits } = await model(inputs);
  return logits.tolist().map((r) => (Array.isArray(r) ? Number(r[0]) : Number(r)));
};
await score(query, docs);
const s = await score(query, docs);
docs.forEach((d, i) => console.log(`  ${s[i].toFixed(2).padStart(7)}  ${d.slice(0, 70)}`));
const many = Array.from({ length: 20 }, (_, i) => docs[i % docs.length]);
const t1 = performance.now();
await score(query, many);
console.log(`20 pairs in ${Math.round(performance.now() - t1)} ms`);
await model.dispose?.();
