// Gold-set evaluation harness.
//
// WHY THIS DOES NOT GO THROUGH /api/v1/search
// -------------------------------------------
// Recall@10 cannot be measured on the API response, and the reason is not a
// missing parameter. Every one of the 600 articles is on ONE host,
// jubileeverse.com, and `zone_a_max_per_host` is 3 — so `diversify()` cuts Zone A
// to three results before coverage sizing ever runs, whatever `size` asks for.
// The deepest Zone A the API can emit on this corpus is 3.
//
// That cap is display policy: it exists so one property cannot fill the block.
// It is not a statement about retrieval quality, and a model swap does not change
// it. So the metric is taken on `rankedA` — the reranked candidate list, up to
// `rerank_candidates` (50) deep — which is the surface a model swap actually
// moves. Display-level truth is reported alongside it as `displayed_rank`.
//
// The harness calls the production modules in the orchestrator's own order. It
// deliberately skips three steps, and says so rather than pretending to be a
// full request:
//
//   * the result cache — a cached payload would make the second run of an
//     evaluation measure the first run
//   * best bets — a pinned result is an editorial override, not retrieval
//   * zone assembly — the cap described above
//
// `driftGuard()` below is what keeps that from rotting: it asserts the harness's
// own top Zone A result equals what search() puts first for a sample of queries.
// If someone changes retrieval and not this file, that check fails.

import { pool } from '../src/db.js';
import { env, ranking } from '../src/config.js';
import { normalize, detectLanguage } from '../src/text/normalize.js';
import { classify, fusionWeights } from '../src/query/intent.js';
import { expand } from '../src/query/lexicon.js';
import { findNavigational, findEntity } from '../src/query/panels.js';
import { getQueryEmbedding } from '../src/query/cache.js';
import { retrieve } from '../src/query/retrieval.js';
import { rerank as rerankCall } from '../src/inference/client.js';
import { assembleZoneA } from '../src/query/coverage.js';

/**
 * Run one query through steps 1–7 and return the ranked Zone A list.
 *
 * @param {boolean|null} rerank  null = follow ranking_config; true/false overrides it
 * @param {'hybrid'|'lexical'|'semantic'} mode
 *   hybrid   — as configured, both arms
 *   lexical  — no query embedding, exactly the degraded path retrieval.js
 *              already supports when the Inference API is down
 *   semantic — the lexical arm's fusion weight set to 0 AND results without a
 *              semantic rank dropped. Zeroing the weight alone is not enough:
 *              a page found only lexically still arrives through the FULL OUTER
 *              JOIN, scoring 0, and would be counted as a semantic hit.
 */
export async function rankZoneA(q, { mode = 'hybrid', rerank = null, column = 'live' } = {}) {
  const db = pool;
  const cfg = await ranking();
  const norm = normalize(q);
  const lang = detectLanguage(norm.normalized, null);

  const [navigational, entity, expansion] = await Promise.all([
    findNavigational(db, norm.normalized).catch(() => null),
    findEntity(db, norm.normalized, lang).catch(() => null),
    expand(db, norm.normalized, lang, cfg).catch(() => ({ conceptIds: [], conceptKeys: [], groups: [] })),
  ]);

  const routed = classify(norm, lang, { navigational, entity });
  const fusion = { ...fusionWeights(routed.intent) };
  if (mode === 'semantic') fusion.lexical = 0;

  const embedding = mode === 'lexical'
    ? null
    : await getQueryEmbedding(db, norm.normalized, env.embeddingModel);

  const ctx = {
    normalized: norm.normalized, lang, expansion, embedding, fusion, cfg,
    filters: {}, debug: true, embeddingColumn: column,
  };

  let results = await retrieve(db, 'A', ctx);
  if (mode === 'semantic') {
    results = results.filter((r) => r.debug?.rrf?.semantic_rank !== null);
  }

  const ranked = await rerankList(results, norm.raw, cfg, rerank);

  return {
    intent: routed.intent,
    lang,
    navigational: navigational ? navigational.host ?? navigational.url ?? true : null,
    expansion_terms: expansion.conceptKeys?.length ?? 0,
    embedding: embedding ? embedding.length : 0,
    ranked,
    // What a reader would actually see, same code path as production.
    displayed: assembleZoneA(ranked, cfg, {}),
  };
}

async function rerankList(results, queryText, cfg, force = null) {
  // `force` overrides ranking_config FOR MEASUREMENT ONLY. Migration 033 set
  // rerank_zone_a = 0, so without this every run silently takes the config's
  // answer -- and a run labelled "rerank on" would not have reranked. A label
  // that does not match what ran is the same failure as a preflight that passes
  // against a toy input: the number looks fine and describes something else.
  const on = force === null ? cfg.rerank_zone_a === 1 : force;
  if (!on || results.length === 0) return results;
  const docs = results.map((r) => [r.title, r.snippet].filter(Boolean).join('\n'));
  const { order, reranked } = await rerankCall(queryText, docs);
  if (!reranked) return results;
  return order.map(({ index, score }, newPosition) => {
    const r = results[index];
    r.debug.rerank = {
      cross_encoder_score: score, fusion_position: index + 1,
      reranked_position: newPosition + 1, delta: index - newPosition,
    };
    return r;
  });
}

/** `cdn:<cat>__<slug>` -> `<cat>__<slug>`, keyed by page_id. */
export async function targetIndex() {
  const { rows } = await pool.query(
    `SELECT id, source_path, url, title FROM pages WHERE source_path LIKE 'cdn:%'`,
  );
  const byId = new Map();
  const byTarget = new Map();
  for (const r of rows) {
    const t = r.source_path.slice(4);
    byId.set(Number(r.id), t);
    byTarget.set(t, { id: Number(r.id), url: r.url, title: r.title });
  }
  return { byId, byTarget };
}

/**
 * Prove the harness still agrees with production.
 *
 * Compares the harness's top-ranked Zone A page against search()'s first
 * zone_a result. They must match: same modules, same order, and the only
 * differences (cache, best bets, assembly) cannot change which page ranks
 * first — a best bet would, which is why a query that matches one fails this
 * guard loudly rather than being excused.
 */
export async function driftGuard(queries) {
  const { search } = await import('../src/query/orchestrator.js');
  const out = [];
  for (const q of queries) {
    const [mine, theirs] = [await rankZoneA(q), await search({ q, zones: ['A'], debug: true })];
    const a = mine.ranked[0]?.page_id ?? null;
    const b = theirs.zone_a?.results?.[0]?.page_id ?? null;
    // coverage 'none' empties the block by design; that is not drift.
    const excused = b === null && theirs.zone_a?.coverage === 'none';
    out.push({ q, harness: a, api: b, agree: a === b || excused, excused });
  }
  return out;
}
