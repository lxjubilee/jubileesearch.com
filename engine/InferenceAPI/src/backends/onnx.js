// ONNX Runtime backend, via @huggingface/transformers.
//
// CPU by default. On a machine with a GPU, INFERENCE_DEVICE selects the ONNX
// execution provider: `dml` (DirectML, the provider onnxruntime-node ships for
// Windows) or `cuda` (Linux builds). transformers.js passes `device` through.
//
// Measured on the JubileeSearch workstation (RTX PRO 6000 via DirectML, fp16):
//   bge-m3 embed, 32 chunks              ~155 ms  (4.8 ms/text; CPU int8: 13 ms/text)
//   bge-m3 embed, one warm query         ~8 ms    (CPU int8: ~17 ms)
//   bge-reranker-base, 20 pairs          ~14 ms   (CPU int8: ~93 ms)
//   first call after load                ~400 ms  (shape compilation, once)
//
// int8 weights run SLOWER on DirectML than on CPU; use fp16 on a GPU.

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
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    // Locally exported models (INFERENCE_LOCAL_MODEL_PATH) are tried before
    // the Hub, so a repo id like `bge-reranker-v2-m3` resolves to
    // <models>/bge-reranker-v2-m3/{config.json, tokenizer.json, onnx/}.
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = env.localModelPath;
  }
  return transformers;
}

// The device, and for DirectML which adapter. ONNX Runtime's `deviceId` for
// the DML provider is DirectML's enumeration, which need not match nvidia-smi:
// on the JubileeSearch workstation the RTX PRO 6000 is nvidia-smi index 1 and
// DML adapter 0. INFERENCE_DML_DEVICE_ID says which; unset means the default.
const deviceOpts = () => {
  if (!env.device || env.device === 'cpu') return {};
  const opts = { device: env.device };
  if (env.device === 'dml' && env.dmlDeviceId !== null) {
    opts.session_options = { executionProviders: [{ name: 'dml', deviceId: env.dmlDeviceId }] };
  }
  return opts;
};

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
    if (!spec.topicRepo) {
      throw new RoleUnsupported(role, name,
        'the family-safety classifier needs BOTH a toxicity model (SAFETY_MODEL_REPO) '
        + 'and a zero-shot topic model (SAFETY_TOPIC_MODEL_REPO). A toxicity head alone '
        + 'does not know what an escort ad or a casino is, and a control that admits '
        + 'those while reporting that it checked is worse than none.');
    }
    return loadSafety(spec);
  }
  throw new ContractViolation(`unknown role '${role}'`);
}

/**
 * Two pipelines behind one role: the toxicity heads and the zero-shot topic
 * classifier. See src/safety.js for how their outputs become one verdict.
 *
 * The zero-shot model runs one NLI pass per label per text, so a page costs a
 * dozen passes. Texts are truncated to `maxInputChars` and classification runs
 * at batch priority, so that cost never sits on a search request.
 */
async function loadSafety(spec) {
  const { pipeline } = await lib();
  const t0 = performance.now();
  const toxic = await pipeline('text-classification', spec.repo, { dtype: spec.dtype, ...deviceOpts() });
  // int8 collapses DeBERTa's NLI head to noise (every label ~0.6); fp16 and
  // fp32 agree with each other. Never quantise the topic model below fp16.
  const topicDtype = ['int8', 'q8', 'q4', 'bnb4', 'q4f16'].includes(spec.dtype) ? 'fp32' : spec.dtype;
  const topics = await pipeline('zero-shot-classification', spec.topicRepo, { dtype: topicDtype, ...deviceOpts() });
  const loadMs = Math.round(performance.now() - t0);
  const { ZERO_SHOT_LABELS } = await import('../safety.js');
  log.info('backend.onnx.loaded', {
    role: 'safety', model: spec.id, repo: spec.repo, topic_repo: spec.topicRepo,
    dtype: spec.dtype, topic_dtype: topicDtype, device: env.device, load_ms: loadMs,
    labels: ZERO_SHOT_LABELS.length,
  });
  return {
    role: 'safety',
    spec,
    loadMs,
    /** @returns {Promise<{toxic: {label: string, score: number}[], topics: {labels: string[], scores: number[]}}[]>} */
    async classify(texts) {
      const clipped = texts.map((t) => String(t ?? '').slice(0, spec.maxInputChars) || '(empty)');
      const toxicOut = await toxic(clipped, { top_k: null });
      const out = [];
      for (let i = 0; i < clipped.length; i += 1) {
        const topicOut = await topics(clipped[i], ZERO_SHOT_LABELS, { multi_label: false });
        const heads = Array.isArray(toxicOut[i]) ? toxicOut[i] : [toxicOut[i]];
        out.push({
          toxic: heads.map((x) => ({ label: x.label, score: x.score })),
          topics: { labels: topicOut.labels, scores: topicOut.scores },
        });
      }
      return out;
    },
    async dispose() { await toxic.dispose?.(); await topics.dispose?.(); },
  };
}
