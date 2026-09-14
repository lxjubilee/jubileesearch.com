// Shared preflight for everything under eval/.
//
// THE RULE, because this recurs:
//
//   §17 requires the search path to degrade quietly under an inference outage.
//   That is right for production and wrong for evaluation. Anything that
//   measures quality must fail loudly exactly where production is required to
//   fail softly.
//
// Do not "fix" this by making it a warning. The graceful degradation it fights
// is a feature of the code it is measuring, and the whole job of a measurement
// harness is to refuse to inherit it.
//
// It exists because of a real failure. The first gold-set baseline was run as
// `node eval/run.mjs` rather than `npm run eval`, so `--env-file-if-exists=.env`
// never applied and INFERENCE_API_URL was empty. Both the semantic arm and the
// reranker degraded silently and the run printed a complete, plausible table:
// recall@10 = 40.0, hybrid and lexical identical to four decimal places. That
// number was on its way to becoming the figure every later model was measured
// against. A baseline that is silently wrong is worse than no baseline.
//
// THE BROADER RULE, which the scratchpad case shows is not about one file:
//
//   A number that reaches a migration must come from a committed script.
//
// Migration 027's thresholds were derived by scripts in a temp directory that no
// longer needs to exist. The values are in version control; the derivation is
// not, so the next retune starts from nothing and the old numbers cannot be
// checked. Same class as the config drift — a value in one place, its
// justification in another — and it recurs on every retune until the derivation
// is committed. That is what eval/derive-thresholds.mjs is for.

import { env } from '../src/config.js';
import { embedQuery, rerank, inferenceStatus } from '../src/inference/client.js';
import { pool } from '../src/db.js';

const DIM = 1024;   // halfvec(1024), 002_core.sql

/**
 * @param {'live'|'prev'} column  which embedding column the caller will read
 * @returns {Promise<{model_id: string, chunks: number, column: string}>}
 */
export async function preflight({ column = 'live' } = {}) {
  const fail = (m) => {
    console.error(`\nPREFLIGHT FAILED: ${m}\n`);
    console.error('  Run it through npm (`npm run eval -- <label>`), not `node eval/...`:');
    console.error('  the npm scripts pass --env-file-if-exists=.env, and without it');
    console.error('  INFERENCE_API_URL is empty and every query silently runs lexical-only.\n');
    process.exit(1);
  };

  const status = inferenceStatus();
  if (!status.configured) fail('INFERENCE_API_URL is empty — search would run lexical-only.');
  if (status.search_mode !== 'hybrid') fail(`search_mode is ${status.search_mode}, not hybrid.`);

  // Two calls, and the first one is thrown away on purpose. A model that has been
  // idle pays a cold cost on its first inference that has nothing to do with
  // whether it can serve the run — and because `embedQuery` swallows a timeout and
  // returns null (correctly: one request degrades to lexical-only rather than
  // 500ing), a cold start would otherwise fail the preflight for the wrong reason.
  // The SECOND call is the one that must pass, and its latency is printed so a
  // genuinely slow embedder is visible rather than merely tolerated.
  await embedQuery('preflight warm-up').catch(() => null);
  const t1 = performance.now();
  const vec = await embedQuery('preflight probe');
  const embedMs = Math.round(performance.now() - t1);
  if (!Array.isArray(vec)) {
    fail(`embedQuery returned nothing after a warm-up call. Either no inference server `
      + `is running, or it cannot answer inside TIMEOUTS.embedQuery `
      + `(${process.env.EMBED_QUERY_TIMEOUT_MS ?? 800} ms) — raise EMBED_QUERY_TIMEOUT_MS deliberately if so.`);
  }
  if (vec.length !== DIM) fail(`embedQuery returned ${vec.length} dimensions; chunks.embedding is halfvec(${DIM}).`);
  console.log(`  query embedding: ${embedMs} ms (§13.10 budgets 60 ms)`);

  // Probe the reranker at the size and shape it will actually see: §6.1 sends the
  // top 50 candidates per zone, each a title plus a snippet.
  //
  // Two one-word documents is NOT a valid probe, and that is not hypothetical.
  // `rerank` has a 2 s timeout and returns the input order unchanged on failure
  // (deliberately — §13.10 makes rerank the first thing to drop under load). A
  // toy probe passes in under a second against a provider that would need two
  // minutes for a real call, so every real rerank silently becomes a no-op while
  // the preflight reports green. The same toy-input mistake produced a published
  // throughput figure that was wrong by more than an order of magnitude.
  const doc = 'Nobody Was Blessed as a Crowd\nA night camera operator watches four '
    + 'hundred people and counts the weeks since anyone said his name.';
  const probeDocs = Array.from({ length: 50 }, () => doc);
  const t0 = performance.now();
  const { reranked } = await rerank('why does nobody say my name anymore', probeDocs);
  const ms = Math.round(performance.now() - t0);
  if (!reranked) {
    fail(`the reranker did not answer for 50 realistic documents in ${ms} ms, so every `
      + 'rerank in this run would silently be a no-op. Either point RERANK_API_URL at a '
      + 'provider that can meet TIMEOUTS.rerank, or raise that timeout deliberately.');
  }
  console.log(`  rerank: 50 documents in ${ms} ms`);

  // The query embedding and the stored chunk vectors must come from the SAME
  // model, or every cosine in the run compares two different vector spaces —
  // which is not a smaller number, it is a meaningless one.
  const col = column === 'prev'
    ? { emb: 'embedding_prev', model: 'model_id_prev' }
    : { emb: 'embedding', model: 'model_id' };
  const { rows } = await pool.query(
    `SELECT ${col.model} AS model_id, count(*)::int n FROM chunks
      WHERE ${col.emb} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);

  if (rows.length === 0) fail(`no chunk has a vector in ${col.emb}.`);
  if (rows.length > 1) {
    fail(`${col.emb} carries ${rows.length} model_ids: `
      + rows.map((r) => `${r.model_id} (${r.n})`).join(', ')
      + '. Mid-backfill this is expected; it is still not a state a single '
      + 'comparable measurement can be taken in.');
  }
  if (env.embeddingModel !== rows[0].model_id) {
    fail(`EMBEDDING_MODEL is '${env.embeddingModel}' but ${col.emb} was written by `
      + `'${rows[0].model_id}'. Cosine between two model spaces is a meaningless number.`);
  }

  console.log(`preflight ok — ${env.embeddingModel}, ${DIM} dims, rerank live, `
    + `${rows[0].n} chunks in ${col.emb}`);
  return { model_id: rows[0].model_id, chunks: rows[0].n, column: col.emb };
}
