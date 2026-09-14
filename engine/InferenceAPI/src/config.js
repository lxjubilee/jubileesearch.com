// Configuration, and the hardware boundary.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a caller never learns what hardware
// is behind this service, and moving to different hardware is a change here and
// nowhere else. §16 makes this a shared Jubilee service, so it will outlive the
// machine it was written on.
//
// Everything hardware-shaped is named in one place:
//
//   INFERENCE_BACKEND   which executor runs the models
//   EMBED_MODEL         which weights fill the embedding role
//   RERANK_MODEL        which weights fill the rerank role
//   SAFETY_MODEL        which weights fill the safety role (none exists yet)
//
// The HTTP contract does not change when any of these do. A caller sends text
// and gets vectors or an ordering; it never sends a device, a dtype or a batch
// size, and it never learns one.

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true');

/**
 * Model roles.
 *
 * A role is a JOB, not a model: "the thing that turns text into a 1024-dim
 * vector". Swapping the weights behind a role is an env var. Adding a role is a
 * contract change and needs a new endpoint.
 *
 * `dim` is declared rather than discovered because it is a promise to the
 * caller, and to `chunks.embedding halfvec(1024)` on the search side. A model
 * whose real output does not match its declared dim must fail at load, loudly,
 * rather than write vectors of the wrong width into somebody's index.
 */
export const ROLES = ['embed', 'rerank', 'safety'];

export const env = {
  port: num(process.env.PORT, 4032),
  host: process.env.HOST ?? '127.0.0.1',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // ---- the hardware boundary ------------------------------------------------
  backend: process.env.INFERENCE_BACKEND ?? 'onnx',
  device: process.env.INFERENCE_DEVICE ?? 'cpu',   // cpu | cuda | dml | webgpu
  dtype: process.env.INFERENCE_DTYPE ?? 'int8',

  // ---- model selection ------------------------------------------------------
  models: {
    embed: {
      id: process.env.EMBED_MODEL_ID ?? 'bge-m3@onnx-int8',
      repo: process.env.EMBED_MODEL_REPO ?? 'Xenova/bge-m3',
      dim: num(process.env.EMBED_DIM, 1024),
      dtype: process.env.EMBED_DTYPE ?? process.env.INFERENCE_DTYPE ?? 'int8',
      maxInputChars: num(process.env.EMBED_MAX_CHARS, 8000),
    },
    rerank: {
      id: process.env.RERANK_MODEL_ID ?? '',
      repo: process.env.RERANK_MODEL_REPO ?? '',
      dtype: process.env.RERANK_DTYPE ?? process.env.INFERENCE_DTYPE ?? 'int8',
      maxInputChars: num(process.env.RERANK_MAX_CHARS, 4000),
      // A cross-encoder scores query and document TOGETHER and returns one
      // logit. A bi-encoder embeds them separately and compares. They are not
      // interchangeable and the difference is measurable, so it is declared
      // rather than inferred -- §6.1 specifies a cross-encoder, and a caller
      // reading /health is entitled to know which one it is actually getting.
      kind: process.env.RERANK_KIND ?? 'cross-encoder',
    },
    safety: {
      id: process.env.SAFETY_MODEL_ID ?? '',
      // The toxicity heads (hostility) ...
      repo: process.env.SAFETY_MODEL_REPO ?? '',
      // ... and the zero-shot NLI model (what the text is about). Both are
      // needed; see src/safety.js for why one is not enough.
      topicRepo: process.env.SAFETY_TOPIC_MODEL_REPO ?? '',
      dtype: process.env.SAFETY_DTYPE ?? process.env.INFERENCE_DTYPE ?? 'int8',
      maxInputChars: num(process.env.SAFETY_MAX_CHARS, 6000),
      unsafeTopicThreshold: num(process.env.SAFETY_UNSAFE_TOPIC_THRESHOLD, 0.5),
    },
  },
  // DirectML enumerates adapters in its own order (not nvidia-smi's). On a
  // box with more than one GPU, this picks which one the ONNX sessions use.
  dmlDeviceId: process.env.INFERENCE_DML_DEVICE_ID === undefined || process.env.INFERENCE_DML_DEVICE_ID === ''
    ? null : Number(process.env.INFERENCE_DML_DEVICE_ID),

  // ---- batching and queueing (§12.2) ---------------------------------------
  // "Batches of 32 to 64 chunks per Inference API call." That is the CALLER's
  // batch. This service coalesces across callers up to maxBatch, which is a
  // different number and depends on the hardware, not the spec.
  maxBatch: num(process.env.MAX_BATCH, 64),
  minBatch: num(process.env.MIN_BATCH, 1),
  batchWaitMs: num(process.env.BATCH_WAIT_MS, 15),
  maxQueueDepth: num(process.env.MAX_QUEUE_DEPTH, 2000),

  // ---- model residency ------------------------------------------------------
  // Models load on first use and stay resident. On a 4 GB card or a laptop with
  // no headroom, holding an embedder AND a cross-encoder may not be possible;
  // `MAX_RESIDENT_MODELS=1` evicts the least recently used instead of failing.
  maxResidentModels: num(process.env.MAX_RESIDENT_MODELS, 2),
  preload: (process.env.PRELOAD ?? 'embed').split(',').map((s) => s.trim()).filter(Boolean),

  // ---- honesty --------------------------------------------------------------
  // §13.10's budgets, so this service can say when it is missing them rather
  // than leaving the caller to discover it. Breaching one is logged at warn with
  // the budget named. See README, "Do not pretend it is fast".
  budgets: {
    embedQueryMs: num(process.env.BUDGET_EMBED_QUERY_MS, 60),
    rerankMs: num(process.env.BUDGET_RERANK_MS, 180),
    classifyMs: num(process.env.BUDGET_CLASSIFY_MS, 500),
  },
  warnOnBudgetBreach: bool(process.env.WARN_ON_BUDGET_BREACH, true),

  apiKey: process.env.INFERENCE_API_KEY ?? '',
};

/** Roles with weights actually configured. A role with no repo is not served. */
export const configuredRoles = () =>
  ROLES.filter((r) => Boolean(env.models[r]?.repo));

export default env;
