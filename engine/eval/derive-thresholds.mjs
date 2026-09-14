// Derive the Zone A coverage thresholds from measurement.
//
// This is the committed replacement for the scratchpad scripts that produced
// migration 027's 0.0080 / 0.0180 / 0.0370. Those values are in version control
// and their derivation was not, so the numbers could not be checked and the next
// retune would have started from nothing. See eval/preflight.mjs for the rule.
//
// Run: USE_PGLITE=1 PGLITE_DIR=.pglite-dev npm run eval:thresholds -- [--column=next]
//
// ---------------------------------------------------------------------------
// THE OBJECTIVE, STATED BEFORE THE RUN
// ---------------------------------------------------------------------------
//
// The floor is chosen to be THE HIGHEST VALUE THAT STILL RETURNS A RESULT FOR
// EVERY GOLD QUERY. It is a recall-preserving floor, not a precision gate.
//
// That is a deliberately weak objective and it must not be quietly upgraded,
// because the strong version is not achievable with the score this floor is
// applied to. The fused score is RRF — `1/(k + rank)` — which is derived from
// RANK and carries no magnitude: a rank-1 result scores identically whether the
// match is excellent or absurd. So no value of the floor separates a good top
// result from a bad one, and the curve below will show the two distributions
// overlapping across their whole range rather than parting at a knee.
//
// Reading a knee into that overlap is the specific mistake this file exists to
// prevent. §13.5's precision goal belongs to the cross-encoder gate
// (`zone_a_cross_encoder_floor`, migration 025, currently -1 and disabled),
// whose score has magnitude and is comparable across queries. The floor's job
// here is only to keep the coverage tiers honest.
//
// moderate and strong are the terciles of the gold-query top-score distribution:
// the sizes are 2 / 3 / 5, so the boundaries are the points that split the
// queries the corpus genuinely answers into three equal bands.

import { readFileSync, writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { rankZoneA } from './harness.mjs';
import { preflight } from './preflight.mjs';

const column = process.argv.includes('--column=next') ? 'next' : 'live';
const models = await preflight({ column });
const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));

const WANTED = gold.pairs.filter((p) => p.type !== 'navigational').map((p) => p.query);
const NEGATIVES = [
  ...gold.negatives.false_positive_expected.map((q) => ({ q, kind: 'false_positive' })),
  ...gold.negatives.honest_weak_match_expected.map((q) => ({ q, kind: 'weak_match' })),
];

const topScore = async (q) => {
  const r = await rankZoneA(q, { column });
  return r.ranked[0]?.score ?? null;
};

const wanted = [];
for (const q of WANTED) { wanted.push({ q, score: await topScore(q) }); process.stdout.write('.'); }
process.stdout.write('\n');
const negatives = [];
for (const n of NEGATIVES) { negatives.push({ ...n, score: await topScore(n.q) }); process.stdout.write('.'); }
process.stdout.write('\n');

const wScores = wanted.map((x) => x.score).filter((s) => s !== null).sort((a, b) => a - b);
const nScores = negatives.map((x) => x.score).filter((s) => s !== null).sort((a, b) => a - b);

// The curve: at each candidate floor, what survives on each side.
const candidates = [...new Set([...wScores, ...nScores])].sort((a, b) => a - b);
const curve = candidates.map((f) => ({
  floor: +f.toFixed(6),
  wanted_kept: wScores.filter((s) => s >= f).length,
  wanted_lost: wScores.filter((s) => s < f).length,
  negatives_admitted: nScores.filter((s) => s >= f).length,
  negatives_blocked: nScores.filter((s) => s < f).length,
}));

// The objective, applied.
const keepsAll = curve.filter((c) => c.wanted_lost === 0);
const floor = keepsAll.length ? keepsAll[keepsAll.length - 1].floor : 0;

const tercile = (p) => wScores[Math.min(wScores.length - 1, Math.floor(wScores.length * p))];
const moderate = +tercile(1 / 3).toFixed(6);
const strong = +tercile(2 / 3).toFixed(6);

// Does the floor separate anything at all? If the two ranges overlap, it does not.
const overlap = wScores.length && nScores.length
  ? { wanted: [wScores[0], wScores.at(-1)], negatives: [nScores[0], nScores.at(-1)],
      separable: nScores.at(-1) < wScores[0] }
  : null;

const out = {
  ran_at: new Date().toISOString(),
  column, model: models.model_id, chunks: models.chunks,
  objective: 'highest floor that loses no gold query; moderate/strong are terciles of the gold top-score distribution',
  n: { wanted: wScores.length, negatives: nScores.length },
  chosen: { zone_a_relevance_floor: floor, zone_a_moderate_threshold: moderate, zone_a_strong_threshold: strong },
  separability: overlap,
  negatives_admitted_at_floor: curve.find((c) => c.floor === floor)?.negatives_admitted ?? nScores.length,
  curve, wanted, negatives,
};
writeFileSync(new URL(`./results/thresholds-${column}-${models.model_id.replace(/[^a-z0-9]+/gi, '-')}.json`, import.meta.url),
  JSON.stringify(out, null, 2));

const w = (s, n) => String(s).padEnd(n);
console.log(`\nthresholds from ${models.model_id} (${column})\n`);
console.log(`  objective: ${out.objective}\n`);
console.log(`  gold top scores  n=${wScores.length}  ${wScores[0]?.toFixed(4)} .. ${wScores.at(-1)?.toFixed(4)}`);
console.log(`  negative  scores n=${nScores.length}  ${nScores[0]?.toFixed(4)} .. ${nScores.at(-1)?.toFixed(4)}`);
console.log(`  separable by a single threshold: ${overlap?.separable ? 'YES' : 'NO — the ranges overlap'}\n`);
console.log(`  ${w('floor', 12)}${w('gold kept', 12)}${w('gold lost', 12)}${w('neg admitted', 14)}neg blocked`);
const step = Math.max(1, Math.floor(curve.length / 24));
for (let i = 0; i < curve.length; i += step) {
  const c = curve[i];
  console.log(`  ${w(c.floor.toFixed(6), 12)}${w(c.wanted_kept, 12)}${w(c.wanted_lost, 12)}${w(c.negatives_admitted, 14)}${c.negatives_blocked}`);
}
console.log(`\n  CHOSEN`);
console.log(`    zone_a_relevance_floor      ${floor.toFixed(6)}   admits ${out.negatives_admitted_at_floor}/${nScores.length} negatives`);
console.log(`    zone_a_moderate_threshold   ${moderate.toFixed(6)}   -> 3 results`);
console.log(`    zone_a_strong_threshold     ${strong.toFixed(6)}   -> 5 results`);
console.log(`\n  Write these into a NEW migration, never through /api/v1/admin/ranking alone.`);

await pool.end();
