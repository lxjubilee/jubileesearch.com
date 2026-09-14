// Why is conversational recall 4/20?
//
// Report only. Nothing here changes configuration.
//
// The question is which of three things it is:
//   RETRIEVAL  the target never enters the candidate pool at all
//   RANKING    it is retrieved, but placed below the cut
//   THE PAIR   the query does not actually identify that article over its peers

import { readFileSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { env, ranking } from '../src/config.js';
import { normalize, detectLanguage } from '../src/text/normalize.js';
import { classify, fusionWeights } from '../src/query/intent.js';
import { expand } from '../src/query/lexicon.js';
import { findNavigational, findEntity } from '../src/query/panels.js';
import { getQueryEmbedding } from '../src/query/cache.js';
import { retrieve } from '../src/query/retrieval.js';
import { rankZoneA, targetIndex } from './harness.mjs';
import { preflight } from './preflight.mjs';

await preflight({ column: 'live' });
const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const { byId, byTarget } = await targetIndex();
const cfg = await ranking();
const PAIRS = gold.pairs.filter((p) => p.type === 'conversational');

/** Retrieve with the candidate pool opened right up, to find where a target really sits. */
async function deepRank(q, targetId) {
  const norm = normalize(q);
  const lang = detectLanguage(norm.normalized, null);
  const [nav, ent, expansion] = await Promise.all([
    findNavigational(pool, norm.normalized).catch(() => null),
    findEntity(pool, norm.normalized, lang).catch(() => null),
    expand(pool, norm.normalized, lang, cfg).catch(() => ({ conceptKeys: [], groups: [] })),
  ]);
  const routed = classify(norm, lang, { navigational: nav, entity: ent });
  const embedding = await getQueryEmbedding(pool, norm.normalized, env.embeddingModel);
  // 20x the usual depth. If the target is not here, it is not retrievable at all
  // by either arm for this query.
  const wide = { ...cfg, retrieval_candidates: 2000, rerank_candidates: 2000 };
  const ctx = {
    normalized: norm.normalized, lang, expansion, embedding,
    fusion: fusionWeights(routed.intent), cfg: wide, filters: {}, debug: true,
  };
  const rows = await retrieve(pool, 'A', ctx);
  const i = rows.findIndex((r) => r.page_id === targetId);
  const hit = i >= 0 ? rows[i] : null;
  return {
    intent: routed.intent,
    fusion: fusionWeights(routed.intent),
    concepts: expansion.conceptKeys ?? [],
    pool: rows.length,
    fusion_rank: i >= 0 ? i + 1 : null,
    lex_rank: hit?.debug?.rrf?.lexical_rank ?? null,
    sem_rank: hit?.debug?.rrf?.semantic_rank ?? null,
    cosine: hit?.debug?.cosine_similarity ?? null,
    // What outranked it, to judge whether the pair is even well posed.
    top3: rows.slice(0, 3).map((r) => byId.get(r.page_id)),
  };
}

const out = [];
for (const p of PAIRS) {
  const shallow = await rankZoneA(p.query, { mode: 'hybrid' });
  const targetId = byTarget.get(p.target)?.id;
  const shallowRank = shallow.ranked.findIndex((x) => x.page_id === targetId);
  const hit = shallowRank >= 0 ? shallow.ranked[shallowRank] : null;
  const deep = await deepRank(p.query, targetId);
  out.push({
    id: p.id, query: p.query, target: p.target,
    intent: deep.intent, fusion: deep.fusion, concepts: deep.concepts,
    final_rank: shallowRank >= 0 ? shallowRank + 1 : null,
    pre_rerank_rank: hit?.debug?.rerank?.fusion_position ?? null,
    rerank_delta: hit?.debug?.rerank?.delta ?? null,
    deep_fusion_rank: deep.fusion_rank,
    deep_pool: deep.pool,
    lex_rank: deep.lex_rank, sem_rank: deep.sem_rank, cosine: deep.cosine,
    top3: deep.top3,
  });
  process.stdout.write('.');
}
process.stdout.write('\n');

writeFileSync(new URL('./results/conversational-investigation.json', import.meta.url),
  JSON.stringify({ ran_at: new Date().toISOString(), pairs: out }, null, 2));

const w = (s, n) => String(s).padEnd(n);
const hits = out.filter((r) => r.final_rank !== null && r.final_rank <= 10);
const miss = out.filter((r) => !(r.final_rank !== null && r.final_rank <= 10));

console.log(`\nintent routing: ` + Object.entries(
  out.reduce((a, r) => { a[r.intent] = (a[r.intent] ?? 0) + 1; return a; }, {}),
).map(([k, v]) => `${k} ${v}/20`).join('   '));
console.log(`fusion weights applied: ` + [...new Set(out.map((r) => JSON.stringify(r.fusion)))].join(' '));

console.log(`\nSUCCEEDS AT @10 (${hits.length}/20)`);
console.log(`  ${w('id', 5)}${w('rank', 6)}${w('pre-rr', 8)}${w('arm', 14)}query`);
for (const r of hits) {
  const arm = r.lex_rank !== null && r.sem_rank !== null ? 'both'
    : r.lex_rank !== null ? 'lexical' : r.sem_rank !== null ? 'semantic' : '—';
  console.log(`  ${w(r.id, 5)}${w(r.final_rank, 6)}${w(r.pre_rerank_rank ?? '—', 8)}${w(arm, 14)}${r.query.slice(0, 50)}`);
}

console.log(`\nFAILS AT @10 (${miss.length}/20)`);
console.log(`  ${w('id', 5)}${w('deep', 7)}${w('lex', 7)}${w('sem', 7)}${w('cos', 8)}${w('verdict', 12)}query`);
for (const r of miss) {
  const verdict = r.deep_fusion_rank === null ? 'RETRIEVAL'
    : r.deep_fusion_rank <= 50 ? 'RANKING' : 'DEEP';
  console.log(`  ${w(r.id, 5)}${w(r.deep_fusion_rank ?? 'absent', 7)}${w(r.lex_rank ?? '—', 7)}`
    + `${w(r.sem_rank ?? '—', 7)}${w(r.cosine ? r.cosine.toFixed(3) : '—', 8)}${w(verdict, 12)}${r.query.slice(0, 44)}`);
}

console.log(`\nWHAT OUTRANKS THE TARGET — first five failures`);
for (const r of miss.slice(0, 5)) {
  console.log(`\n  ${r.id}  "${r.query}"`);
  console.log(`    wanted: ${r.target}`);
  console.log(`    got:    ${r.top3.filter(Boolean).join('\n            ')}`);
}

await pool.end();
