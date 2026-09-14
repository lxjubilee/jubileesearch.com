// The backend contract.
//
// A backend knows how to LOAD weights and RUN them. It knows nothing about HTTP,
// queueing, batching, priorities or budgets — those are the same whatever
// executes the model, and duplicating them per backend is how two backends drift
// into behaving differently.
//
// This is the seam the whole service exists to protect. When a GPU arrives, the
// change is a new file in this directory and INFERENCE_BACKEND pointing at it.
// Nothing above this line moves, and no caller notices.
//
// ---------------------------------------------------------------------------
// A backend module must export:
//
//   name              string, matching its INFERENCE_BACKEND value
//   describe()        -> { name, device, runtime, notes }   for /health
//   load(role, spec)  -> Promise<LoadedModel>
//
// A LoadedModel must expose whichever of these its role needs:
//
//   embed(texts: string[])              -> Promise<number[][]>
//   scorePairs(query, docs: string[])   -> Promise<number[]>    cross-encoder
//   classify(text: string)              -> Promise<{...}>
//   dispose()                           -> Promise<void>        free the weights
//   dim                                 number, embed only
//
// `scorePairs` is deliberately not called `rerank`. Reranking is a decision —
// take these scores, sort, return an ordering. Scoring is what a model does. The
// service owns the decision so that every backend returns comparable numbers and
// the sort happens in exactly one place.
// ---------------------------------------------------------------------------

/** Thrown when a role is asked of a backend that cannot serve it. */
export class RoleUnsupported extends Error {
  constructor(role, backend, detail = '') {
    super(`backend '${backend}' cannot serve role '${role}'${detail ? `: ${detail}` : ''}`);
    this.name = 'RoleUnsupported';
    this.role = role;
    this.backend = backend;
    this.status = 501;
  }
}

/** Thrown when weights load but do not match what was promised to callers. */
export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractViolation';
    this.status = 500;
  }
}

/**
 * Every backend's loaded embedding model passes through this before being used.
 *
 * The dimension is a promise made to callers and to `chunks.embedding
 * halfvec(1024)` on the search side. A model that returns 384 where 1024 was
 * declared does not degrade — on the search side every insert fails, halfway
 * through a backfill, hours in. Better to refuse at load.
 *
 * Padding a narrower model up to the declared width is a legitimate development
 * choice and it is NOT done silently: the caller sees a model id that says so
 * (`...@padded1024`) and /health reports `padded: true`.
 */
export function assertEmbeddingContract(spec, actualDim) {
  if (actualDim === spec.dim) return { padded: false, nativeDim: actualDim };
  if (actualDim > spec.dim) {
    throw new ContractViolation(
      `${spec.id} returns ${actualDim} dimensions but ${spec.dim} was declared. `
      + 'Truncating would silently change the vector space; refusing instead.');
  }
  if (!/padded/i.test(spec.id)) {
    throw new ContractViolation(
      `${spec.id} returns ${actualDim} dimensions, ${spec.dim} was declared. `
      + `Zero-padding is available but the model id must say so — use `
      + `'${spec.id}@padded${spec.dim}' — so that vectors written under it are `
      + 'identifiable later. An index full of padded vectors that claims to be '
      + 'native is not recoverable without re-embedding everything.');
  }
  return { padded: true, nativeDim: actualDim };
}
