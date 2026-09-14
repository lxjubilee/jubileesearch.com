// Compare two eval runs pair by pair. `node eval/compare.mjs <a> <b>`
//
// A headline recall figure says which model won. It does not say WHERE, and a
// model that gains on one register while losing on another nets out to a number
// that looks like nothing happened.

import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2);
const load = (l) => JSON.parse(readFileSync(new URL(`./results/${l}.json`, import.meta.url), 'utf8'));
const A = load(a);
const B = load(b);

const w = (s, n) => String(s).padEnd(n);
const sign = (n) => (n > 0 ? `+${n}` : String(n));

console.log(`${a}  ->  ${b}`);
console.log(`  ${A.model_id.model_id}  ->  ${B.model_id.model_id}`);
console.log(`  reranker: ${A.rerank_provider} / ${B.rerank_provider}`
  + `${A.rerank_provider === B.rerank_provider ? '  (held constant)' : '  *** DIFFERENT — the delta is not the model ***'}`);

console.log(`\n  ${w('', 14)}${w('R@1', 14)}${w('R@3', 14)}${w('R@5', 14)}${w('R@10', 14)}MRR`);
for (const mode of ['hybrid', 'lexical', 'semantic']) {
  const x = A.summary[mode]; const y = B.summary[mode];
  const cell = (k) => `${y[k]} (${sign(+(y[k] - x[k]).toFixed(1))})`;
  console.log(`  ${w(mode, 14)}${w(cell('recall@1'), 14)}${w(cell('recall@3'), 14)}`
    + `${w(cell('recall@5'), 14)}${w(cell('recall@10'), 14)}`
    + `${y.mrr} (${sign(+(y.mrr - x.mrr).toFixed(4))})`);
}

console.log(`\n  hybrid recall@10 by type`);
console.log(`  ${w('', 18)}${w('n', 5)}${w(a.slice(0, 10), 12)}${w(b.slice(0, 10), 12)}delta`);
for (const t of Object.keys(A.summary.hybrid.by_type)) {
  const x = A.summary.hybrid.by_type[t]; const y = B.summary.hybrid.by_type[t];
  const d = +(y['recall@10'] - x['recall@10']).toFixed(1);
  console.log(`  ${w(t, 18)}${w(x.n, 5)}${w(x['recall@10'], 12)}${w(y['recall@10'], 12)}`
    + `${sign(d)}${d === 0 ? '' : d > 0 ? '  better' : '  WORSE'}`);
}

// Pair-level movement: what each model found that the other did not.
const byId = new Map(A.pairs.map((p) => [p.id, p]));
const gained = []; const lost = []; const moved = [];
for (const p of B.pairs) {
  const q = byId.get(p.id); if (!q) continue;
  const rb = p.modes.hybrid.rank; const ra = q.modes.hybrid.rank;
  const inA = ra !== null && ra <= 10; const inB = rb !== null && rb <= 10;
  if (!inA && inB) gained.push({ id: p.id, type: p.type, q: p.query, from: ra, to: rb });
  else if (inA && !inB) lost.push({ id: p.id, type: p.type, q: p.query, from: ra, to: rb });
  else if (inA && inB && ra !== rb) moved.push({ id: p.id, type: p.type, from: ra, to: rb, d: ra - rb });
}

const show = (title, list) => {
  console.log(`\n  ${title} (${list.length})`);
  for (const x of list) {
    console.log(`    ${w(x.id, 6)}${w(x.type, 16)}${w(`${x.from ?? '—'} -> ${x.to ?? '—'}`, 14)}${(x.q ?? '').slice(0, 58)}`);
  }
};
show(`ENTERED top 10 under ${b}`, gained);
show(`LEFT top 10 under ${b}`, lost);

const up = moved.filter((m) => m.d > 0).sort((x, y) => y.d - x.d);
const down = moved.filter((m) => m.d < 0).sort((x, y) => x.d - y.d);
console.log(`\n  moved up ${up.length}, moved down ${down.length}, unchanged `
  + `${A.pairs.length - gained.length - lost.length - moved.length}`);
console.log(`    biggest gains:  ${up.slice(0, 6).map((m) => `${m.id} ${m.from}->${m.to}`).join('  ')}`);
console.log(`    biggest drops:  ${down.slice(0, 6).map((m) => `${m.id} ${m.from}->${m.to}`).join('  ')}`);

// Cross-register is the subset the model swap was expected to move most.
console.log(`\n  cross-register, pair by pair`);
console.log(`  ${w('id', 6)}${w(a.slice(0, 10), 10)}${w(b.slice(0, 10), 10)}${w('arm (B)', 16)}query`);
for (const p of B.pairs.filter((x) => x.type === 'cross-register')) {
  const q = byId.get(p.id);
  const arm = p.modes.hybrid.lex_rank !== null && p.modes.hybrid.sem_rank !== null ? 'both'
    : p.modes.hybrid.lex_rank !== null ? 'lexical only'
    : p.modes.hybrid.sem_rank !== null ? 'semantic only' : '—';
  console.log(`  ${w(p.id, 6)}${w(q.modes.hybrid.rank ?? '—', 10)}${w(p.modes.hybrid.rank ?? '—', 10)}`
    + `${w(arm, 16)}${p.query.slice(0, 52)}`);
}
