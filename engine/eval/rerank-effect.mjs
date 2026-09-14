// Is the reranker helping or hurting? Report only.
//
// The conversational investigation found five targets ranked 1, 1, 2, 4 and 5 by
// fusion that the rerank stage pushed out of the top 10. That is a stage doing
// the opposite of its job, so it is worth measuring over the whole gold set
// rather than the subset that exposed it.
//
// Same query, same retrieval, rerank on and off. Nothing else differs.

import { readFileSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { rankZoneA, targetIndex } from './harness.mjs';
import { preflight } from './preflight.mjs';

const models = await preflight({ column: 'live' });
const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const { byTarget } = await targetIndex();
const PAIRS = gold.pairs.filter((p) => p.type !== 'navigational');

const rows = [];
for (const p of PAIRS) {
  const id = byTarget.get(p.target)?.id;
  const on = await rankZoneA(p.query, { mode: 'hybrid', rerank: true });
  const off = await rankZoneA(p.query, { mode: 'hybrid', rerank: false });
  const rankIn = (r) => { const i = r.ranked.findIndex((x) => x.page_id === id); return i >= 0 ? i + 1 : null; };
  rows.push({ id: p.id, type: p.type, query: p.query, with: rankIn(on), without: rankIn(off) });
  process.stdout.write('.');
}
process.stdout.write('\n');

const at = (n, key) => rows.filter((r) => r[key] !== null && r[key] <= n).length;
const pct = (n) => ((100 * n) / rows.length).toFixed(1);

const byType = {};
for (const t of [...new Set(rows.map((r) => r.type))]) {
  const sub = rows.filter((r) => r.type === t);
  const c = (key, n) => sub.filter((r) => r[key] !== null && r[key] <= n).length;
  byType[t] = { n: sub.length, with10: c('with', 10), without10: c('without', 10),
    with5: c('with', 5), without5: c('without', 5), with1: c('with', 1), without1: c('without', 1) };
}

const w = (s, n) => String(s).padEnd(n);
console.log(`\nrerank effect — ${models.model_id} retrieval, MiniLM reranker\n`);
console.log(`  ${w('', 12)}${w('rerank ON', 12)}${w('rerank OFF', 12)}delta`);
for (const n of [1, 3, 5, 10]) {
  const a = at(n, 'with'); const b = at(n, 'without');
  console.log(`  ${w(`recall@${n}`, 12)}${w(`${pct(a)} (${a}/${rows.length})`, 12)}`
    + `${w(`${pct(b)} (${b}/${rows.length})`, 12)}${b - a > 0 ? `+${b - a} WITHOUT` : b - a < 0 ? `${b - a}` : '0'} pairs`);
}

console.log(`\n  by type, recall@10`);
console.log(`  ${w('type', 17)}${w('n', 5)}${w('ON', 10)}${w('OFF', 10)}delta`);
for (const [t, s] of Object.entries(byType)) {
  const d = s.without10 - s.with10;
  console.log(`  ${w(t, 17)}${w(s.n, 5)}${w(`${s.with10}/${s.n}`, 10)}${w(`${s.without10}/${s.n}`, 10)}`
    + `${d > 0 ? `+${d} without rerank` : d < 0 ? `${d}` : '0'}`);
}

const hurt = rows.filter((r) => r.without !== null && r.without <= 10 && !(r.with !== null && r.with <= 10));
const helped = rows.filter((r) => r.with !== null && r.with <= 10 && !(r.without !== null && r.without <= 10));
console.log(`\n  rerank COST these ${hurt.length} pairs a top-10 place:`);
for (const r of hurt) console.log(`    ${w(r.id, 6)}${w(r.type, 16)}${w(`${r.without} -> ${r.with ?? 'out'}`, 14)}${r.query.slice(0, 48)}`);
console.log(`\n  rerank WON these ${helped.length} pairs a top-10 place:`);
for (const r of helped) console.log(`    ${w(r.id, 6)}${w(r.type, 16)}${w(`${r.without ?? 'out'} -> ${r.with}`, 14)}${r.query.slice(0, 48)}`);

writeFileSync(new URL('./results/rerank-effect.json', import.meta.url),
  JSON.stringify({ ran_at: new Date().toISOString(), model: models.model_id,
    reranker: process.env.RERANK_API_URL, by_type: byType, pairs: rows }, null, 2));
await pool.end();
