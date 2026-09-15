// How much should fusion order count once the cross-encoder has spoken?
//
//   node --env-file=.env eval/rerank-blend.mjs
//
// The reranker decides Zone A order outright. On the gold set that helps most
// types and hurts a few pairs badly: a page the vectors put first can be sent
// to 27th because the 700 characters the reranker read were the wrong 700.
// This runs every gold query once, keeps each candidate's fusion position and
// cross-encoder logit, and then scores the set offline under several blends,
// so the question is answered with one pass over the inference service rather
// than one eval run per setting.
//
// Blends are on rank, not score: the two scales (RRF ~0.03, logits -11..0) do
// not mix, and a rank blend is what a `rerank_fusion_weight` config key would
// implement. final = (1 - w) * rerank_position + w * fusion_position, ascending.

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { rankZoneA, targetIndex } from './harness.mjs';

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const { byId } = await targetIndex();
const WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];

const rows = [];
for (const pair of gold.pairs) {
  if (pair.type === 'navigational') continue;
  const r = await rankZoneA(pair.query, { rerank: true });
  const accepted = new Set([pair.target, ...(pair.also_accept ?? [])]);
  const cands = r.ranked.map((x, i) => ({
    key: byId.get(x.page_id),
    rerank_pos: i + 1,
    fusion_pos: x.debug?.rerank?.fusion_position ?? i + 1,
    hit: accepted.has(byId.get(x.page_id)),
  }));
  rows.push({ id: pair.id, type: pair.type, cands });
  process.stdout.write('.');
}
process.stdout.write('\n');

function score(w) {
  const at = { 3: 0, 5: 0, 10: 0 };
  const byType = {};
  for (const row of rows) {
    const ordered = [...row.cands]
      .map((c) => ({ ...c, s: (1 - w) * c.rerank_pos + w * c.fusion_pos }))
      .sort((a, b) => a.s - b.s || a.rerank_pos - b.rerank_pos);
    const rank = ordered.findIndex((c) => c.hit) + 1;
    byType[row.type] ??= { n: 0, 10: 0, 5: 0 };
    byType[row.type].n++;
    for (const k of [3, 5, 10]) if (rank > 0 && rank <= k) { at[k]++; if (k !== 3) byType[row.type][k]++; }
  }
  const n = rows.length;
  const pc = (v, d) => (100 * v / d).toFixed(0);
  return {
    w, 'R@3': pc(at[3], n), 'R@5': pc(at[5], n), 'R@10': pc(at[10], n),
    ...Object.fromEntries(Object.entries(byType).map(([t, s]) => [t, `${pc(s[10], s.n)}/${pc(s[5], s.n)}`])),
  };
}

console.log(`\n${rows.length} pairs; per type: R@10/R@5. w = weight on fusion position (0 = reranker alone, 1 = fusion alone)\n`);
console.table(WEIGHTS.map(score));
await pool.end?.();
