// Search latency against the running engine. Report only; changes nothing.
//
//   node eval/latency.mjs <label> [--seconds=60] [--concurrency=4] [--url=...]
//
// Written for one question: does an embedding backfill degrade search while it
// runs? On PGlite that question was unanswerable — single writer, so the engine
// had to be stopped for any job to touch the database. On real Postgres it is
// answerable, and it is the whole reason for the move.
//
// LATENCY IS SPLIT BY CACHE HIT, and that is not a detail. §13.7 caches results
// for 15 minutes, so a second pass over the same queries measures the cache, not
// the database. Comparing a cached idle run against an uncached loaded one would
// manufacture a regression; comparing MISS latency across phases is the honest
// number. Both are reported, with the hit rate, so neither can hide the other.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
const label = process.argv[2] ?? 'latency';
const seconds = Number(arg('seconds', 60));
const concurrency = Number(arg('concurrency', 4));
const base = arg('url', 'http://127.0.0.1:4038');

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const QUERIES = [
  ...gold.pairs.map((p) => p.query),
  ...gold.negatives.false_positive_expected,
  ...gold.negatives.honest_weak_match_expected,
];

const samples = [];
const errors = [];
let sent = 0;

async function one(q) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&zones=A`,
      { signal: AbortSignal.timeout(30_000) });
    const ms = performance.now() - t0;
    if (!r.ok) { errors.push({ q, status: r.status, ms }); return; }
    const j = await r.json();
    samples.push({ q, ms, cache_hit: j.cache_hit === true, took_ms: j.took_ms, results: j.zone_a?.results?.length ?? 0 });
  } catch (e) {
    errors.push({ q, error: e.name === 'TimeoutError' ? 'timeout (30s)' : e.message, ms: performance.now() - t0 });
  }
}

// PACED, because the rate limiter is production behaviour and must not be
// switched off to take a measurement. §14 allows 60 searches per minute per IP
// anonymous. An unpaced run at concurrency 4 sent ~660/min and collected 885
// HTTP 429s against 105 successes — a latency figure computed from that is a
// measurement of the rate limiter, not of the database.
const rpm = Number(arg('rpm', 55));            // headroom under the 60 ceiling
const minGapMs = (60_000 / rpm) * concurrency;

const deadline = Date.now() + seconds * 1000;
async function worker(offset) {
  let i = offset;
  while (Date.now() < deadline) {
    const started = Date.now();
    await one(QUERIES[i % QUERIES.length]);
    i += concurrency;
    sent += 1;
    const wait = minGapMs - (Date.now() - started);
    if (wait > 0 && Date.now() + wait < deadline) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};
const stats = (xs) => ({
  n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99),
  max: xs.length ? +Math.max(...xs).toFixed(1) : null,
});

const miss = samples.filter((s) => !s.cache_hit).map((s) => s.ms);
const hit = samples.filter((s) => s.cache_hit).map((s) => s.ms);

const out = {
  label, ran_at: new Date().toISOString(), base, seconds, concurrency, rpm,
  requests: sent, ok: samples.length, failed: errors.length,
  cache_hit_rate: samples.length ? +((100 * hit.length) / samples.length).toFixed(1) : 0,
  all: stats(samples.map((s) => s.ms)),
  cache_miss: stats(miss),
  cache_hit: stats(hit),
  errors: errors.slice(0, 20),
};

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/latency-${label}.json`, import.meta.url), JSON.stringify(out, null, 2));

const w = (s, n) => String(s).padEnd(n);
console.log(`\n${label} — ${sent} requests over ${seconds}s at concurrency ${concurrency}`);
console.log(`  ok ${samples.length}   failed ${errors.length}   cache hit rate ${out.cache_hit_rate}%`);
console.log(`\n  ${w('', 14)}${w('n', 7)}${w('p50', 10)}${w('p95', 10)}${w('p99', 10)}max`);
for (const [k, s] of [['all', out.all], ['cache MISS', out.cache_miss], ['cache hit', out.cache_hit]]) {
  console.log(`  ${w(k, 14)}${w(s.n, 7)}${w(s.p50 ?? '—', 10)}${w(s.p95 ?? '—', 10)}${w(s.p99 ?? '—', 10)}${s.max ?? '—'}`);
}
if (errors.length) {
  console.log(`\n  failures:`);
  const byKind = errors.reduce((a, e) => { const k = e.error ?? `HTTP ${e.status}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  for (const [k, n] of Object.entries(byKind)) console.log(`    ${w(k, 24)}${n}`);
}
console.log(`\n  §17 target: p95 500 ms on a cache miss`);
console.log(`  written to eval/results/latency-${label}.json`);
