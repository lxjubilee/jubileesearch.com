// Acceptance criterion 20: "a test set of at least 200 known-unsafe URLs is
// classified with 100% rejection. Anything less blocks release of T3."
//
//   node --env-file=.env eval/unsafe.mjs [--set=eval/unsafe-set.json]
//
// Runs every item through the same gates the crawler runs (safety/gates.js
// evaluate, tier T3) against the production blocklist and the Inference API.
// Nothing is fetched: listed hosts must fall at gate 1 before a request is
// spent, and the unlisted items carry their own title, description and body so
// gates 2 and 3 are exercised on text the set controls. A page that comes back
// anything other than `unsafe` is a failure and is printed; the exit code is
// the verdict on the criterion.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db.js';
import { ranking } from '../src/config.js';
import { loadRules, evaluate, VERDICTS } from '../src/safety/gates.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const setPath = new URL(`../${arg('set', 'eval/unsafe-set.json')}`, import.meta.url);
const set = JSON.parse(readFileSync(setPath, 'utf8'));

const rules = await loadRules(pool);
const cfg = await ranking();

const rows = [];
const byGate = {};
for (const item of set.items) {
  const host = new URL(item.url).hostname;
  const t0 = performance.now();
  const v = await evaluate({
    tier: 'T3', host, url: item.url,
    title: item.title ?? '', description: item.description ?? '', bodyText: item.body ?? '',
  }, rules, cfg);
  const gate = v.reasons?.find((r) => r.severity >= 100 || r.gate === 3)?.gate ?? v.reasons?.[0]?.gate ?? null;
  const rejected = v.verdict === VERDICTS.UNSAFE;
  rows.push({ url: item.url, category: item.category, expect: item.expect, verdict: v.verdict,
    score: v.score, gate, ms: Math.round(performance.now() - t0), rejected,
    reasons: rejected ? undefined : v.reasons });
  byGate[gate ?? 'none'] = (byGate[gate ?? 'none'] ?? 0) + (rejected ? 1 : 0);
  process.stdout.write(rejected ? '.' : 'X');
}
process.stdout.write('\n');

const n = rows.length;
const rejected = rows.filter((r) => r.rejected).length;
const failures = rows.filter((r) => !r.rejected);
const out = {
  ran_at: new Date().toISOString(),
  set_version: set.version,
  items: n,
  rejected,
  rejection_rate: +(100 * rejected / n).toFixed(1),
  rejected_by_gate: byGate,
  acceptance_20: { min_items_200: n >= 200, all_rejected: failures.length === 0, pass: n >= 200 && failures.length === 0 },
  failures,
  rows,
};
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = `unsafe-${set.version}-${out.ran_at.slice(0, 10)}.json`;
writeFileSync(new URL(`./results/${file}`, import.meta.url), JSON.stringify(out, null, 2));

console.log(`\n${n} items, ${rejected} rejected (${out.rejection_rate}%)  by gate: ${JSON.stringify(byGate)}`);
for (const f of failures) console.log(`  NOT REJECTED  ${f.verdict.padEnd(12)} ${f.category.padEnd(12)} ${f.url}\n    ${JSON.stringify(f.reasons)}`);
console.log(`\n  acceptance 20: ${out.acceptance_20.pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(out.acceptance_20)}`);
console.log(`  written to eval/results/${file}`);
await pool.end();
process.exit(out.acceptance_20.pass ? 0 : 1);
