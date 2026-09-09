// Zone retrieval (§13.1 step [6], §13.6, Appendix A.1).
//
// Two zones, two retrievals, two signal sets. The single most important thing in
// this file is what is *not* here: there is no tier multiplier, and no code path
// in which a T2 or T3 page can be scored against a T1 page. P8 and R1 replaced
// that comparison with a structural separation, so Zone A reads zone_a_pages and
// Zone B reads zone_b_pages and the two never meet until assembly.
//
// Both zones follow the same shape: lexical top N, semantic top N, RRF fuse,
// multiplicative signal boost, then hand the top `rerank_candidates` to the
// cross-encoder. The shape is Appendix A.1; the differences from it are marked
// where they occur.

import { groupToTsquery } from './lexicon.js';

const ZONE_VIEW = { A: 'zone_a_pages', B: 'zone_b_pages' };

/**
 * @param {object} db      pg pool or client
 * @param {'A'|'B'} zone
 * @param {object} ctx
 * @param {string} ctx.normalized
 * @param {string} ctx.lang
 * @param {{groups: {weight:number, terms:string[]}[]}} ctx.expansion
 * @param {number[]|null} ctx.embedding   null when the vector path is unavailable
 * @param {{lexical:number, semantic:number}} ctx.fusion  intent-driven weights
 * @param {object} ctx.cfg      ranking config
 * @param {object} ctx.filters  {site, category, persona, lang, tiers}
 * @param {boolean} ctx.debug
 */
export async function retrieve(db, zone, ctx) {
  if (!ctx.normalized) return [];
  const { sql, params } = buildQuery(zone, ctx);
  const { rows } = await db.query(sql, params);
  return rows.map((r) => shape(r, zone, ctx));
}

function buildQuery(zone, ctx) {
  const { cfg, filters = {}, expansion } = ctx;
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  const langParam = p(ctx.lang);
  const queryParam = p(ctx.normalized);

  // One tsquery per distinct expansion weight, so §13.3's "original terms at
  // full weight and expanded terms at their configured weight" is honoured.
  // Appendix A.1 folds everything into one string, which cannot express a weight.
  const groups = [];
  for (const group of expansion?.groups ?? []) {
    const text = groupToTsquery(group.terms);
    if (text) groups.push({ weight: group.weight, param: p(text) });
  }

  const tsqSelect = [
    `websearch_to_tsquery(c.reg, ${queryParam}) AS q0`,
    ...groups.map((g, i) => `to_tsquery(c.reg, ${g.param}) AS q${i + 1}`),
  ].join(', ');

  const lexScore = [
    `ts_rank_cd(p.body_tsv, t.q0)`,
    ...groups.map((g, i) => `${g.weight} * ts_rank_cd(p.body_tsv, t.q${i + 1})`),
  ].join(' + ');

  const anyMatch = ['t.q0', ...groups.map((_, i) => `t.q${i + 1}`)].join(' || ');

  const view = ZONE_VIEW[zone];
  const where = ['TRUE'];

  if (filters.site) where.push(`p.domain_id = (SELECT id FROM domains WHERE host = ${p(filters.site)})`);
  if (filters.category) where.push(`p.category = ${p(filters.category)}`);
  if (filters.persona) where.push(`p.persona = ${p(filters.persona)}`);
  if (filters.lang) where.push(`p.language = ${p(filters.lang)}`);
  // `tier=` narrows *within* Zone B only (§14). It can never widen a zone,
  // because the zone view has already fixed which tiers are in play.
  if (zone === 'B' && filters.tiers?.length) where.push(`p.tier = ANY(${p(filters.tiers)}::trust_tier[])`);

  const filterSql = where.join(' AND ');
  const candidates = p(Math.max(1, cfg.retrieval_candidates));
  const rrfK = p(cfg.rrf_k);
  const wLex = p(ctx.fusion.lexical);
  const wSem = p(ctx.fusion.semantic);

  // The semantic half is optional. Before Phase 4 there are no embeddings at
  // all, and after it the Inference API can still be down -- §17 allows ingest
  // to be unavailable without affecting search, and the same principle applies
  // here. Lexical-only is a degraded answer; no answer is a worse one.
  const hasVector = Array.isArray(ctx.embedding) && ctx.embedding.length > 0;
  const vecParam = hasVector ? p(`[${ctx.embedding.join(',')}]`) : null;
  const tierPredicate = zone === 'A' ? `= 'T1'` : `IN ('T2','T3')`;

  const semanticCte = hasVector
    ? `
    , sem_raw AS (
        -- Runs against the zone's partial HNSW index (migration 011). Fetching
        -- 3x candidates in chunks, because several chunks of one page can crowd
        -- the neighbourhood and only the best of them survives the next step.
        SELECT ch.page_id, ch.id AS chunk_id, ch.text, ch.heading_path,
               ch.embedding <=> ${vecParam}::halfvec AS dist
        FROM chunks ch
        WHERE ch.tier ${tierPredicate} AND ch.embedding IS NOT NULL
        ORDER BY ch.embedding <=> ${vecParam}::halfvec
        LIMIT ${candidates}::int * 3
    )
    , sem_best AS (
        SELECT DISTINCT ON (page_id) page_id, chunk_id, text, heading_path, dist
        FROM sem_raw ORDER BY page_id, dist
    )
    , semantic AS (
        -- The servability join happens here rather than inside sem_raw: pushing
        -- it down would stop the planner using the HNSW index. Over-fetching
        -- above is what pays for filtering here.
        SELECT s.page_id, s.chunk_id, s.text AS chunk_text, s.heading_path, s.dist,
               ROW_NUMBER() OVER (ORDER BY s.dist) AS rank
        FROM sem_best s
        JOIN ${view} p ON p.id = s.page_id
        WHERE ${filterSql}
        ORDER BY s.dist
        LIMIT ${candidates}
    )`
    : `
    , semantic AS (
        SELECT NULL::bigint AS page_id, NULL::bigint AS chunk_id,
               NULL::text AS chunk_text, NULL::text AS heading_path,
               NULL::float AS dist, NULL::bigint AS rank
        WHERE FALSE
    )`;

  // §13.6 Zone A vs Zone B signal sets. Both are multiplicative on the RRF
  // score, both take their weights from ranking_config at request time.
  const boost = zone === 'A'
    ? `
        (1 + ${p(cfg.w_quality)}::numeric * COALESCE(p.quality_score, 0) / 100)
      * (1 + ${p(cfg.w_engage)}::numeric  * COALESCE(p.engagement_score, 0) / 100)`
    : `
        (1 + ${p(cfg.w_tier2)}::numeric  * (CASE WHEN p.tier = 'T2' THEN 1 ELSE 0 END))
      * (1 + ${p(cfg.w_safety)}::numeric * COALESCE(p.safety_score, 0) / 100)`;

  const wCtr = p(cfg.w_ctr);
  const wLang = p(cfg.w_lang);
  const wFresh = p(cfg.w_fresh);
  const halflife = p(cfg.freshness_halflife_days);
  const ctrQuery = p(ctx.normalized);
  const rerankCandidates = p(Math.max(1, cfg.rerank_candidates));

  const sql = `
    WITH c AS (SELECT ts_config_for(${langParam}) AS reg)
    , tsq AS (SELECT ${tsqSelect} FROM c)
    , lexical AS (
        SELECT p.id AS page_id, (${lexScore}) AS lex_score
        FROM ${view} p CROSS JOIN tsq t
        WHERE p.body_tsv @@ (${anyMatch}) AND ${filterSql}
        ORDER BY (${lexScore}) DESC
        LIMIT ${candidates}
    )
    , lexical_ranked AS (
        SELECT page_id, lex_score, ROW_NUMBER() OVER (ORDER BY lex_score DESC) AS rank
        FROM lexical
    )
    ${semanticCte}
    , fused AS (
        SELECT COALESCE(l.page_id, s.page_id) AS page_id,
               l.rank AS lex_rank,
               l.lex_score,
               s.rank AS sem_rank,
               s.chunk_text,
               s.heading_path,
               s.dist,
               COALESCE(${wLex}::numeric / (${rrfK}::numeric + l.rank), 0) AS rrf_lex,
               COALESCE(${wSem}::numeric / (${rrfK}::numeric + s.rank), 0) AS rrf_sem
        FROM lexical_ranked l
        FULL OUTER JOIN semantic s ON l.page_id = s.page_id
    )
    SELECT p.id, p.url, p.title, p.description, p.tier, p.language,
           p.category, p.persona, p.office, p.related_slugs, p.characters,
           p.published_at, p.modified_at, p.quality_score, p.engagement_score,
           p.safety_score, d.host, d.display_name,
           f.lex_rank, f.sem_rank, f.lex_score, f.rrf_lex, f.rrf_sem, f.dist,
           f.chunk_text, f.heading_path,
           (f.rrf_lex + f.rrf_sem) AS rrf,
           COALESCE(ctr.corrected_ctr, 0) AS corrected_ctr,
           COALESCE(ctr.confidence, 0)    AS ctr_confidence,
           (CASE WHEN p.language = ${langParam} THEN 1 ELSE 0 END) AS lang_match,
           exp(-GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(p.published_at, p.first_seen_at))) / 86400, 0)
               / NULLIF(${halflife}::numeric, 0)) AS freshness,
           ts_headline(ts_config_for(${langParam}), COALESCE(p.body_text, ''), t.q0,
                       'MaxFragments=1, MaxWords=32, MinWords=12, ShortWord=3, StartSel=<mark>, StopSel=</mark>')
             AS headline,
           (f.rrf_lex + f.rrf_sem)
             * ${boost}
             * (1 + ${wCtr}::numeric   * COALESCE(ctr.corrected_ctr, 0) * COALESCE(ctr.confidence, 0))
             * (1 + ${wLang}::numeric  * (CASE WHEN p.language = ${langParam} THEN 1 ELSE 0 END))
             * (1 + ${wFresh}::numeric * exp(-GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(p.published_at, p.first_seen_at))) / 86400, 0)
                                    / NULLIF(${halflife}::numeric, 0)))
             AS score
    FROM fused f
    JOIN ${view} p ON p.id = f.page_id
    JOIN domains d ON d.id = p.domain_id
    CROSS JOIN tsq t
    LEFT JOIN query_page_ctr ctr
           ON ctr.page_id = p.id AND ctr.normalized_query = ${ctrQuery}
    ORDER BY score DESC
    LIMIT ${rerankCandidates}`;

  return { sql, params };
}

function shape(row, zone, ctx) {
  const result = {
    page_id: Number(row.id),
    url: row.url,
    title: row.title,
    description: row.description,
    host: row.host,
    site_name: row.display_name,
    tier: row.tier,
    language: row.language,
    category: row.category,
    persona: row.persona,
    office: row.office,
    related_slugs: row.related_slugs ?? [],
    characters: row.characters ?? [],
    published_at: row.published_at,
    modified_at: row.modified_at,
    zone,
    score: Number(row.score),
    // §13.8: snippets are always extracted text, never generated. ts_headline on
    // the lexical path; for a page that arrived only through the vector path
    // there is no headline to make, so the best-matching chunk stands in.
    snippet: pickSnippet(row),
    snippet_source: row.lex_rank !== null ? 'headline' : 'chunk',
  };

  // P4: "Every result row must be able to answer 'why was this returned, in
  // which zone, and why at this position.'" debug=true is how that is satisfied
  // in practice (§14), so the breakdown is the full arithmetic and not a summary.
  if (ctx.debug) {
    result.debug = {
      zone_reason: zone === 'A'
        ? 'tier T1 on a zone_a_eligible domain'
        : `tier ${row.tier} (wider web)`,
      rrf: { lexical_rank: numOrNull(row.lex_rank), semantic_rank: numOrNull(row.sem_rank),
             lexical_contribution: Number(row.rrf_lex), semantic_contribution: Number(row.rrf_sem),
             k: ctx.cfg.rrf_k, intent_weights: ctx.fusion, total: Number(row.rrf) },
      // The two PRE-FUSION magnitudes. RRF is built from rank and therefore
      // carries no magnitude at all -- a rank-1 result scores alike whether the
      // match is excellent or terrible -- so these are the only numbers in the
      // payload that say how good a match actually is.
      lexical_score: numOrNull(row.lex_score),
      vector_distance: numOrNull(row.dist),
      cosine_similarity: row.dist === null || row.dist === undefined ? null : 1 - Number(row.dist),
      boosts: zone === 'A'
        ? { quality: factor(ctx.cfg.w_quality, row.quality_score, 100),
            engagement: factor(ctx.cfg.w_engage, row.engagement_score, 100),
            ctr: 1 + ctx.cfg.w_ctr * Number(row.corrected_ctr) * Number(row.ctr_confidence),
            language: 1 + ctx.cfg.w_lang * Number(row.lang_match),
            freshness: 1 + ctx.cfg.w_fresh * Number(row.freshness) }
        : { tier2: 1 + ctx.cfg.w_tier2 * (row.tier === 'T2' ? 1 : 0),
            safety: factor(ctx.cfg.w_safety, row.safety_score, 100),
            ctr: 1 + ctx.cfg.w_ctr * Number(row.corrected_ctr) * Number(row.ctr_confidence),
            language: 1 + ctx.cfg.w_lang * Number(row.lang_match),
            freshness: 1 + ctx.cfg.w_fresh * Number(row.freshness) },
      signals: { corrected_ctr: Number(row.corrected_ctr), ctr_confidence: Number(row.ctr_confidence),
                 quality_score: numOrNull(row.quality_score), engagement_score: numOrNull(row.engagement_score),
                 safety_score: numOrNull(row.safety_score) },
      score_after_boost: Number(row.score),
    };
  }
  return result;
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const factor = (weight, value, scale) => 1 + weight * (Number(value ?? 0) / scale);

function pickSnippet(row) {
  if (row.lex_rank !== null && row.headline) return row.headline;
  return truncateAtSentence(row.chunk_text ?? row.description ?? '', 200);
}

// "truncated to roughly 200 characters at a sentence boundary" (§13.8). Roughly
// is the operative word: cutting at the last sentence end before the limit is
// better than cutting mid-word, but a chunk with no sentence break in 200
// characters still has to end somewhere.
export function truncateAtSentence(text, limit) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const window = clean.slice(0, limit + 40);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (stop > limit * 0.5) return window.slice(0, stop + 1);
  const space = clean.lastIndexOf(' ', limit);
  return `${clean.slice(0, space > 0 ? space : limit)}…`;
}
