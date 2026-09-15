// Acceptance 24: p95 latency under 500 ms on cache miss and under 100 ms on
// cache hit, at 50 concurrent queries.
//
//   node eval/load.mjs [--base=http://127.0.0.1:4038] [--concurrency=50] [--seconds=30]
//
// Two phases, both at the given concurrency. MISS: every query is unique (a
// random suffix that the normaliser keeps), so nothing is served from the
// result cache. HIT: a fixed set of twenty queries repeated, so after the
// first round everything is cached. Reports p50/p95/p99 wall-clock per phase
// and the error count. Run on the production box against localhost so the
// number is the engine's, not the network's.

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const BASE = arg('base', 'http://127.0.0.1:4038').replace(/\/$/, '');
const CONC = Number(arg('concurrency', 50));
const SECONDS = Number(arg('seconds', 30));

const TOPICS = ['grace and mercy', 'Shabbat rest', 'teshuvah return to God', 'Holy Spirit dry bones',
  'covenant identity', 'ketubah marriage', 'Jonah mercy', 'firstfruits offering', 'Passover lamb',
  'prayer at midnight', 'forgiveness seventy times', 'the good shepherd', 'kingdom of heaven parable',
  'Sabbath healing', 'Ruach HaKodesh seal', 'wilderness manna', 'Pentecost fire', 'Yom Kippur atonement',
  'sukkot booths', 'salvation by faith'];

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };

async function phase(name, makeQuery) {
  const lat = []; let errors = 0; let n = 0;
  const end = Date.now() + SECONDS * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const q = makeQuery(n++);
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) errors++; else await res.json();
      } catch { errors++; }
      lat.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  const out = { phase: name, concurrency: CONC, seconds: SECONDS, requests: lat.length, errors,
    rps: Math.round(lat.length / SECONDS), p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), p99_ms: pct(lat, 0.99) };
  console.log(JSON.stringify(out));
  return out;
}

const miss = await phase('miss', (i) => `${TOPICS[i % TOPICS.length]} ${Math.random().toString(36).slice(2, 8)}`);
const hit = await phase('hit', (i) => TOPICS[i % TOPICS.length]);
console.log(JSON.stringify({
  acceptance_24: { miss_p95_under_500: miss.p95_ms < 500, hit_p95_under_100: hit.p95_ms < 100 },
}));
