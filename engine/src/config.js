// Runtime configuration.
//
// Two kinds. Environment holds deployment facts -- where the database is, where
// the Inference API is -- and changes only on deploy. `ranking_config` holds
// everything the ranker and assembler read per request, and §13.6 requires it
// to be "adjustable at runtime without deployment". So the ranking half is read
// from the database and cached briefly, not read from env.
import { query } from './db.js';

export const env = {
  port: Number(process.env.PORT ?? 4038),          // api.jubileesearch.com, per ops/config
  inferenceUrl: process.env.INFERENCE_API_URL ?? '',
  inferenceKey: process.env.INFERENCE_API_KEY ?? '',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'bge-m3@v1',
  rerankModel: process.env.RERANK_MODEL ?? 'bge-reranker-v2-m3@v1',
  safetyModel: process.env.SAFETY_MODEL ?? '',
  jsvApiUrl: process.env.JSV_API_URL ?? '',
  analyticsApiUrl: process.env.ANALYTICS_API_URL ?? '',
  jubileepediaApiUrl: process.env.JUBILEEPEDIA_API_URL ?? '',
  ssoJwksUrl: process.env.SSO_JWKS_URL ?? '',
  botContactEmail: process.env.BOT_CONTACT_EMAIL ?? '',   // decision D7
  corsAllowlist: (process.env.CORS_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

// The defaults here mirror migration 022. They exist so the pipeline still has
// coherent numbers if the config table has not been seeded, not as a second
// source of truth: the database wins whenever it has a row.
const DEFAULTS = {
  w_quality: 0.15, w_engage: 0.20, w_ctr: 0.25, w_lang: 0.20,
  w_fresh: 0.08, w_tier2: 0.10, w_safety: 0.05,
  zone_a_strong_threshold: 0.04,
  zone_a_moderate_threshold: 0.025,
  zone_a_weak_threshold: 0.015,
  zone_a_relevance_floor: 0.015,
  zone_a_max_results: 5,
  zone_b_max_results: 10,
  zone_a_max_per_host: 3,
  zone_b_max_per_host: 2,
  lexicon_expansion_weight: 0.60,
  cache_ttl_topical_s: 900,
  cache_ttl_navigational_s: 3600,
  rerank_zone_a: 1,
  rerank_zone_b: 1,
  rerank_candidates: 50,
  retrieval_candidates: 100,
  rrf_k: 60,
  safety_auto_index_confidence: 0.90,
  safety_review_confidence: 0.70,
  safety_domain_strike_limit: 5,
  abuse_reports_to_suppress: 3,
};

const TTL_MS = 30_000;   // admin screen 9 edits must show up quickly (acceptance 17 shape)
let cache = null;
let cachedAt = 0;
let indexVersion = 1;

export async function ranking(force = false) {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const [cfg, ver] = await Promise.all([
      query('SELECT key, value FROM ranking_config'),
      query('SELECT version FROM index_version WHERE id'),
    ]);
    const next = { ...DEFAULTS };
    for (const row of cfg.rows) next[row.key] = Number(row.value);
    indexVersion = Number(ver.rows[0]?.version ?? 1);
    cache = Object.freeze(next);
    cachedAt = Date.now();
  } catch (err) {
    // Losing the config table must not take search down with it. Serve the
    // defaults and say so loudly.
    console.error(JSON.stringify({ level: 'error', at: 'config.ranking', msg: err.message }));
    cache = Object.freeze({ ...DEFAULTS });
    cachedAt = Date.now();
  }
  return cache;
}

// Part of every cache key (§7.9). Bumping it in the database invalidates the
// whole result cache atomically, with no delete sweep.
export const currentIndexVersion = () => indexVersion;

export const rankingDefaults = DEFAULTS;
