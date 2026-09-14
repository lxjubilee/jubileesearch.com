// ONNX Runtime backend, via @huggingface/transformers.
//
// Runs on CPU today because this machine has no NVIDIA GPU — verified, not
// assumed: nvidia-smi is absent and there are zero NVIDIA PnP devices. The same
// file targets CUDA by setting INFERENCE_DEVICE=cuda, because transformers.js
// passes `device` straight through to ONNX Runtime's execution provider. That is
// the whole GPU migration for this backend.
//
// Measured here (Ryzen 9 6900HX, 8 cores, int8):
//   bge-m3 embed, 500-word chunk    ~2,050 ms
//   bge-m3 embed, one short query   ~180-300 ms
//   cold load                       ~20-180 s depending on cache state
//
// Those numbers are properties of the hardware, not of this file.

import { env } from '../config.js';
import { log } from '../log.js';
import { RoleUnsupported, ContractViolation, assertEmbeddingContract } from './backend.js';

export const name = 'onnx';

export function describe() {
  return {
    name,
    device: env.device,
    runtime: '@huggingface/transformers (ONNX Runtime)',
    notes: env.device === 'cpu'
      ? 'CPU execution. Set INFERENCE_DEVICE=cuda on a machine with an NVIDIA GPU; no other change is needed.'
      : `${env.device} execution provider`,
  };
}

// transformers.js is imported once, lazily. It pulls a large native module and
// there is no reason to pay that when the service is only answering /health.
let transformers = null;
async function lib() {
  if (!transformers) transformers = await import('@huggingface/transformers');
  return transformers;
}

const deviceOpts = () => (env.device && env.device !== 'cpu' ? { device: env.device } : {});

/** Mean-pooled, L2-normalised, padded to the declared width if narrower. */
async function loadEmbedder(spec) {
  const { pipeline } = await lib();
  const t0 = performance.now();
  const pipe = await pipeline('feature-extraction', spec.repo, {
    dtype: spec.dtype, ...deviceOpts(),
  });
  const loadMs = Math.round(performance.now() - t0);

  // One probe, so the dimension contract is checked at load rather than on the
  // first request that matters.
  const probe = await pipe(['dimension probe'], { pooling: 'mean', normalize: true });
  const nativeDim = probe.dims[1];
  const { padded } = assertEmbeddingContract(spec, nativeDim);

  log.info('backend.onnx.loaded', {
    role: 'embed', model: spec.id, repo: spec.repo, dtype: spec.dtype,
    device: env.device, native_dim: nativeDim, declared_dim: spec.dim, padded, load_ms: loadMs,
  });

  return {
    role: 'embed',
    spec,
    dim: spec.dim,
    nativeDim,
    padded,
    loadMs,
    async embed(texts) {
      const clipped = texts.map((t) => String(t ?? '').slice(0, spec.maxInputChars));
      const out = await pipe(clipped, { pooling: 'mean', normalize: true });
      const [rows, dim] = out.dims;
      const vectors = [];
      for (let r = 0; r < rows; r += 1) {
        const v = new Array(spec.dim).fill(0);
        for (let i = 0; i < dim; i += 1) v[i] = out.data[r * dim + i];
        vectors.push(v);
      }
      return vectors;
    },
    async dispose() { await pipe.dispose?.(); },
  };
}

/**
 * Cross-encoder scorer. Query and document go through the model TOGETHER and one
 * logit comes back — which is why it can judge a question against an answer that
 * shares none of its words, and why a bi-encoder cannot.
 */
async function loadCrossEncoder(spec) {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await lib();
  const t0 = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
  const model = await AutoModelForSequenceClassification.from_pretrained(spec.repo, {
    dtype: spec.dtype, ...deviceOpts(),
  });
  const loadMs = Math.round(performance.now() - t0);

  log.info('backend.onnx.loaded', {
    role: 'rerank', model: spec.id, repo: spec.repo, dtype: spec.dtype,
    device: env.device, kind: 'cross-encoder', load_ms: loadMs,
  });

  return {
    role: 'rerank',
    spec,
    kind: 'cross-encoder',
    loadMs,
    async scorePairs(query, docs) {
      if (docs.length === 0) return [];
      const q = String(query ?? '').slice(0, spec.maxInputChars);
      const pairs = docs.map((d) => String(d ?? '').slice(0, spec.maxInputChars));
      const inputs = tokenizer(new Array(pairs.length).fill(q), {
        text_pair: pairs, padding: true, truncation: true,
      });
      const { logits } = await model(inputs);
      // One logit per pair. `.tolist()` gives [[x],[x],...]; flatten to numbers.
      return logits.tolist().map((row) => (Array.isArray(row) ? Number(row[0]) : Number(row)));
    },
    async dispose() { await model.dispose?.(); },
  };
}

/** Bi-encoder stand-in: embed separately, compare by cosine. NOT a cross-encoder. */
async function loadBiEncoderReranker(spec) {
  const embedder = await loadEmbedder({ ...spec, dim: spec.dim ?? 1024, maxInputChars: spec.maxInputChars });
  log.warn('backend.onnx.loaded', {
    role: 'rerank', model: spec.id, kind: 'bi-encoder',
    msg: 'This is a bi-encoder stand-in, not the cross-encoder §6.1 specifies. It '
       + 'rewards surface similarity between query and document, which is the wrong '
       + 'signal for a question whose answer does not resemble it. Measured on the '
       + 'JubileeSearch gold set it cost 12 result pairs a top-10 place to win 4.',
  });
  return {
    role: 'rerank',
    spec,
    kind: 'bi-encoder',
    loadMs: embedder.loadMs,
    async scorePairs(query, docs) {
      const [q, ...ds] = await embedder.embed([query, ...docs]);
      return ds.map((d) => cosine(q, d));
    },
    async dispose() { await embedder.dispose(); },
  };
}

function cosine(a, b) {
  let dot = 0; let ma = 0; let mb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return (ma && mb) ? dot / Math.sqrt(ma * mb) : 0;
}

export async function load(role, spec) {
  if (!spec?.repo) {
    throw new RoleUnsupported(role, name, 'no model repository is configured for this role');
  }
  if (role === 'embed') return loadEmbedder(spec);
  if (role === 'rerank') {
    return spec.kind === 'bi-encoder' ? loadBiEncoderReranker(spec) : loadCrossEncoder(spec);
  }
  if (role === 'safety') {
    // The slot exists; nothing fills it. See routes/safety.js — this refuses
    // rather than approximating, on purpose.
    throw new RoleUnsupported(role, name,
      'no family-safety classifier is configured. A keyword list in this position '
      + 'is a control that does not control anything: it would admit unsafe pages '
      + 'while reporting that it had checked them.');
  }
  throw new ContractViolation(`unknown role '${role}'`);
}
