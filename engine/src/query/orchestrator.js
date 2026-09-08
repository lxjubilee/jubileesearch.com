// The query orchestrator: §13.1, the eight numbered steps, in order.
//
//   [1] normalise            [5] best bets
//   [2] detect language      [6] cache check
//   [3] intent router        [7] dual-zone retrieval, fuse, rerank, assemble
//   [4] lexicon expansion    [8] log impressions
//
// Steps 3, 4 and 5 need three independent database reads and are issued
// together; the latency budget in §13.10 allows 35 ms for all of steps 1 to 5
// combined, which serialised round trips would spend on waiting alone.

import { pool } from '../db.js';
import { env, ranking } from '../config.js';
import { normalize, detectLanguage } from '../text/normalize.js';
import { classify, fusionWeights, cacheTtlSeconds } from './intent.js';
import { expand } from './lexicon.js';
import { matchBestBets } from './bestbets.js';
import { findNavigational, findEntity, navigationalResult, scriptureCard, threadContinuations } from './panels.js';
import { cacheKey, readResultCache, writeResultCache, getQueryEmbedding } from './cache.js';
import { retrieve } from './retrieval.js';
import { assembleZoneA, assembleZoneB } from './coverage.js';
import { rerank as rerankCall } from '../inference/client.js';

/**
 * @param {object} params
 * @param {string} params.q
 * @param {string[]} [params.zones]     default ['A','B']
 * @param {object}  [params.filters]
 * @param {number}  [params.page]
 * @param {number}  [params.size]
 * @param {boolean} [params.rerank]
 * @param {boolean} [params.debug]      requires the search_admin right; the
 *                                      caller checks that, not this function
 * @param {string}  [params.sessionId]
 * @param {string}  [params.jubileeId]
 * @param {string}  [params.preferSite]  widget mode: this host leads Zone A (§14)
 */
export async function search(params) {
  const started = process.hrtime.bigint();
  const db = pool;
  const cfg = await ranking();

  // [1] normalise, [2] language
  const q = normalize(params.q);
  const lang = params.filters?.lang || detectLanguage(q.normalized, params.langHint);

  const zones = params.zones?.length ? params.zones : ['A', 'B'];
  const wantA = zones.includes('A');
  const wantB = zones.includes('B');

  // [3] router inputs, [4] expansion, [5] best bets -- concurrently.
  const [navigational, entity, expansion, bestBets] = await Promise.all([
    findNavigational(db, q.normalized).catch(nullOnError('panels.navigational')),
    findEntity(db, q.normalized, lang).catch(nullOnError('panels.entity')),
    expand(db, q.normalized, lang, cfg).catch(() => ({ conceptIds: [], conceptKeys: [], groups: [] })),
    matchBestBets(db, q.normalized, lang),
  ]);

  const routed = classify(q, lang, { navigational, entity });
  const fusion = fusionWeights(routed.intent);

  // [6] cache. §13.7: bypassed entirely "whenever a best bet matched or a debug
  // flag is set" -- a pinned result must appear within 30 seconds of being
  // created (acceptance 17), and a debug payload is never worth caching.
  const bypassCache = bestBets.length > 0 || params.debug === true;
  const key = cacheKey({
    normalized: q.normalized, lang,
    conceptKeys: expansion.conceptKeys,
    filters: params.filters, zones,
    size: params.size, page: params.page, rerank: params.rerank,
  });

  if (!bypassCache) {
    const cached = await readResultCache(db, key).catch(nullOnError('cache.read'));
    if (cached) {
      // A cache hit still logs impressions (§13.7). Skipping that would make
      // popular queries invisible to the click loop, which is exactly backwards.
      const queryId = await logQuery(db, {
        q, lang, routed, expansion, params,
        zoneA: cached.zone_a?.results?.length ?? 0,
        zoneB: cached.zone_b?.results?.length ?? 0,
        cacheHit: true, latencyMs: elapsedMs(started),
      });
      await logImpressions(db, queryId, cached);
      return { ...cached, cache_hit: true, query_id: queryId, took_ms: elapsedMs(started) };
    }
  }

  // Query embedding, from the LRU or the shared table or the Inference API.
  // Null means lexical-only for this request; retrieval handles it.
  const embedding = q.normalized
    ? await getQueryEmbedding(db, q.normalized, env.embeddingModel)
    : null;

  const ctx = {
    normalized: q.normalized, lang, expansion, embedding, fusion, cfg,
    filters: params.filters ?? {}, debug: params.debug === true,
  };

  // [7] retrieval. The two zones are retrieved in parallel and never compared.
  const [rawA, rawB] = await Promise.all([
    wantA ? retrieve(db, 'A', ctx) : [],
    wantB ? retrieve(db, 'B', ctx) : [],
  ]);

  const doRerank = params.rerank !== false;
  const [rankedA, rankedB] = await Promise.all([
    maybeRerank(rawA, q.raw, doRerank && cfg.rerank_zone_a === 1, ctx),
    maybeRerank(rawB, q.raw, doRerank && cfg.rerank_zone_b === 1, ctx),
  ]);

  // §14 widget mode: the host site leads Zone A, then the rest of the network.
  const zoneA = assembleZoneA(rankedA, cfg, { preferHost: params.preferSite ?? null });
  const zoneB = assembleZoneB(rankedB, cfg, { page: params.page ?? 1 });

  // Panels. The scripture card is fetched only for a scripture query, and only
  // then does the JSV round trip cost anything.
  const [card, threads] = await Promise.all([
    routed.intent === 'scripture' ? scriptureCard(routed.scripture) : null,
    zoneA.results.length ? threadContinuations(db, zoneA.results).catch(() => new Map()) : new Map(),
  ]);

  for (const result of zoneA.results) {
    const links = threads.get(result.page_id);
    if (links?.length) result.thread = links;
  }

  const payload = {
    query: q.raw,
    // A scripture query whose card could not be resolved is reported as what it
    // then is -- an ordinary query -- rather than as a scripture query with a
    // missing card. The reader sees no difference; the analytics do.
    intent: routed.intent === 'scripture' && !card ? 'topical' : routed.intent,
    lang,
    best_bets: bestBets,
    scripture_card: card,
    entity_panel: routed.intent === 'entity' ? entity : null,
    navigational: routed.intent === 'navigational'
      ? await navigationalResult(db, navigational).catch(nullOnError('panels.navigationalResult'))
      : null,
    zone_a: wantA ? zoneA : null,
    zone_b: wantB ? zoneB : null,
    suggestions: [],
    cache_hit: false,
  };

  if (ctx.debug) {
    payload.debug = {
      normalized: q.normalized,
      routable: q.routable,
      detected_language: lang,
      intent: routed.intent,
      scripture_reference: routed.scripture?.ref ?? null,
      expansion: { concepts: expansion.conceptKeys, groups: expansion.groups },
      fusion_weights: fusion,
      vector_path: embedding ? 'available' : 'unavailable (lexical only)',
      rerank: { zone_a: doRerank && cfg.rerank_zone_a === 1, zone_b: doRerank && cfg.rerank_zone_b === 1 },
      candidates: { zone_a: rawA.length, zone_b: rawB.length },
      coverage_thresholds: {
        strong: cfg.zone_a_strong_threshold,
        moderate: cfg.zone_a_moderate_threshold,
        floor: cfg.zone_a_relevance_floor,
      },
      cache_key: key,
      cache_bypassed: bypassCache,
    };
  }

  if (!bypassCache) {
    await writeResultCache(db, key, payload, cacheTtlSeconds(routed.intent, cfg))
      .catch(nullOnError('cache.write'));
  }

  // [8] log
  const queryId = await logQuery(db, {
    q, lang, routed, expansion, params,
    zoneA: zoneA.results.length, zoneB: zoneB.results.length,
    cacheHit: false, latencyMs: elapsedMs(started),
  });
  await logImpressions(db, queryId, payload);

  return { ...payload, query_id: queryId, took_ms: elapsedMs(started) };
}

// ---------------------------------------------------------------------------

async function maybeRerank(results, queryText, enabled, ctx) {
  if (!enabled || results.length === 0) return results;

  const docs = results.map((r) => [r.title, r.snippet].filter(Boolean).join('\n'));
  const { order, reranked } = await rerankCall(queryText, docs);
  if (!reranked) return results;

  const out = order.map(({ index, score }, newPosition) => {
    const r = results[index];
    if (ctx.debug) {
      r.debug.rerank = {
        cross_encoder_score: score,
        fusion_position: index + 1,
        reranked_position: newPosition + 1,
        // Positive means the cross-encoder promoted it. P4 wants "why at this
        // position" answerable, and this is the half of the answer that fusion
        // cannot give.
        delta: index - newPosition,
      };
    }
    return r;
  });

  // The cross-encoder decides order within a zone; it never moves a result
  // between zones, and the scores it returns are not comparable across zones.
  // Preserving `score` from the boost stage is what keeps coverage sizing
  // (§13.5) reading the same scale the thresholds were tuned against.
  return out;
}

async function logQuery(db, { q, lang, routed, expansion, params, zoneA, zoneB, cacheHit, latencyMs }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO search_queries
         (query_text, normalized, expanded_concepts, intent, lang,
          jubilee_id, session_id, zone_a_count, zone_b_count, cache_hit, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [q.raw, q.normalized, expansion.conceptIds, routed.intent, lang,
       // §17 privacy: jubilee_id is stored "only where the user is signed in".
       params.jubileeId ?? null, params.sessionId ?? null,
       zoneA, zoneB, cacheHit, latencyMs]);
    return Number(rows[0].id);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'log.query', msg: err.message }));
    return null;
  }
}

// R7 ships in Phase 3 even though nothing reads it until Phase 5: "Data not
// collected is data that cannot be recovered."
async function logImpressions(db, queryId, payload) {
  if (!queryId) return;
  const rows = [];
  for (const [zone, block] of [['A', payload.zone_a], ['B', payload.zone_b]]) {
    for (const r of block?.results ?? []) {
      if (r.page_id) rows.push([queryId, r.page_id, zone, r.position]);
    }
  }
  if (rows.length === 0) return;

  try {
    // One statement, unnested. A loop of inserts here would put a round trip per
    // result on the response path.
    await db.query(
      `INSERT INTO result_impressions (query_id, page_id, zone, position)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[])
       ON CONFLICT (query_id, zone, position) DO NOTHING`,
      [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])]);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'log.impressions', msg: err.message }));
  }
}

const elapsedMs = (started) => Number((process.hrtime.bigint() - started) / 1_000_000n);

const nullOnError = (at) => (err) => {
  console.warn(JSON.stringify({ level: 'warn', at, msg: err.message }));
  return null;
};
