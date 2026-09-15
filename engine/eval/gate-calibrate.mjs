// Calibrate a rerank-free Zone A gate.
//
//   node --env-file=.env eval/gate-calibrate.mjs
//
// The fused RRF score cannot tell "best of a good set" from "best of nothing":
// "best pizza recipe" fuses to 0.028 (strong) because both arms always return
// *something*. With the cross-encoder off (OPEN-ITEMS §23) the only relevance
// signals left are the vector cosine and whether any page matched every
// original term. This runs the gold positives and the negatives, rerank off,
// and prints those two signals for the top of each list, so a floor can be
// chosen that empties the off-topic queries and keeps the real ones.

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { rankZoneA } from './harness.mjs';

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const sets = [
  ['positive', gold.pairs.filter((p) => p.type !== 'navigational').map((p) => p.query)],
  ['off-topic', gold.negatives.false_positive_expected.map((n) => n.q ?? n.query ?? n)],
  ['weak-match', gold.negatives.honest_weak_match_expected.map((n) => n.q ?? n.query ?? n)],
];

const rows = [];
for (const [kind, queries] of sets) {
  for (const q of queries) {
    const r = await rankZoneA(q, { rerank: false });
    const top5 = r.ranked.slice(0, 5);
    const cos = (x) => x?.debug?.cosine_similarity ?? null;
    const strict = (x) => (x?.debug?.lexical_score ?? 0) >= 2;
    rows.push({
      kind, q,
      top_cos: cos(top5[0]),
      max_cos5: top5.length ? Math.max(...top5.map((x) => cos(x) ?? 0)) : 0,
      strict5: top5.some(strict),
      strict_any: r.ranked.some(strict),
    });
    process.stdout.write('.');
  }
}
process.stdout.write('\n');

const pct = (xs, p) => { const s = xs.filter((v) => v !== null).sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))].toFixed(3) : 'n/a'; };
for (const kind of ['positive', 'off-topic', 'weak-match']) {
  const sub = rows.filter((r) => r.kind === kind);
  const mc = sub.map((r) => r.max_cos5);
  console.log(`\n${kind} (${sub.length}): max cosine in top 5 -- p10 ${pct(mc, 0.1)} p25 ${pct(mc, 0.25)} p50 ${pct(mc, 0.5)} p90 ${pct(mc, 0.9)}; strict lexical in top 5: ${sub.filter((r) => r.strict5).length}`);
}
console.log('\nfor a cosine floor F, off-topic emptied / positives lost / weak-match emptied:');
for (const F of [0.60, 0.62, 0.64, 0.65, 0.66, 0.67, 0.68, 0.70]) {
  const gate = (r) => r.max_cos5 >= F || r.strict5;
  const n = (k) => rows.filter((r) => r.kind === k);
  console.log(`  ${F.toFixed(2)}: ${n('off-topic').filter((r) => !gate(r)).length}/${n('off-topic').length}   ${n('positive').filter((r) => !gate(r)).length}/${n('positive').length}   ${n('weak-match').filter((r) => !gate(r)).length}/${n('weak-match').length}`);
}
console.log('\noff-topic queries with the highest cosine:');
for (const r of rows.filter((r) => r.kind === 'off-topic').sort((a, b) => b.max_cos5 - a.max_cos5).slice(0, 6)) console.log(`  ${r.max_cos5.toFixed(3)} strict=${r.strict5}  ${r.q}`);
console.log('positives with the lowest cosine:');
for (const r of rows.filter((r) => r.kind === 'positive').sort((a, b) => a.max_cos5 - b.max_cos5).slice(0, 6)) console.log(`  ${r.max_cos5.toFixed(3)} strict=${r.strict5}  ${r.q}`);
await pool.end?.();
