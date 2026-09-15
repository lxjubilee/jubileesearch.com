// Score the gold set. `node eval/run.mjs <label>` writes eval/results/<label>.json
//
// The engine must be stopped: PGlite is single-writer.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pool } from '../src/db.js';
import { ranking } from '../src/config.js';
import { rankZoneA, targetIndex, driftGuard } from './harness.mjs';
import { preflight } from './preflight.mjs';

const label = process.argv[2] ?? 'run';
// --column=prev evaluates the retired vectors alongside the live ones, so a
// cutover can be checked in both directions. Same gold set, one column different.
const column = process.argv.includes('--column=prev') ? 'prev' : 'live';
// --rerank=on|off overrides ranking_config for this measurement. Recorded in the
// result file so a run can never claim a configuration it did not use.
const rerankArg = process.argv.find((a) => a.startsWith('--rerank='))?.split('=')[1];
const rerankOverride = rerankArg === 'on' ? true : rerankArg === 'off' ? false : null;

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf8'));
const { byId } = await targetIndex();
const cfg = await ranking();
const models = await preflight({ column });

// The reranker must be the SAME provider on both sides of a model comparison.
// Swapping the embedder by pointing INFERENCE_API_URL at a second server also
// swaps the reranker, and then the delta belongs to two changes at once. Set
// RERANK_API_URL explicitly and this records which provider actually served it.
const rerankProvider = process.env.RERANK_API_URL || process.env.INFERENCE_API_URL;

// EVAL_SITE=jubileeverse.com restricts retrieval to one host. The gold set was
// authored against the 600-article CDN corpus; on the whole network its
// targets compete with sibling sites' articles on the same themes, and this
// is how to tell that competition apart from a retrieval loss.
const siteFilter = process.env.EVAL_SITE ? { site: process.env.EVAL_SITE } : {};
// EVAL_SITE=jubileeverse.com restricts retrieval to one host. The gold set was
// authored against the 600-article CDN corpus; on the whole network its
// targets compete with sibling sites' articles on the same themes, and this
// is how to tell that competition apart from a retrieval loss.
const siteFilter = process.env.EVAL_SITE ? { site: process.env.EVAL_SITE } : {};
const MODES = ['hybrid', 'lexical', 'semantic'];
const rows = [];

for (const pair of gold.pairs) {
  const row = { ...pair, modes: {} };

  for (const mode of MODES) {
    const r = await rankZoneA(pair.query, { mode, column, rerank: rerankOverride, filters: siteFilter });

    if (pair.type === 'navigational') {
      // A navigational pair is answered by the panel (§13.4), not by Zone A. It
      // is graded on the panel because that is where the product puts the answer;
      // grading it on Zone A would score the wrong subsystem.
      const wantHost = pair.target.replace('__navigational__', '');
      row.modes[mode] = {
        rank: r.navigational && String(r.navigational).includes(wantHost) ? 1 : null,
        via: 'panel',
        panel: r.navigational ?? null,
        intent: r.intent,
      };
      continue;
    }

    const rank = r.ranked.findIndex((x) => byId.get(x.page_id) === pair.target);
    const displayed = r.displayed.results.findIndex((x) => byId.get(x.page_id) === pair.target);
    const hit = rank >= 0 ? r.ranked[rank] : null;
    row.modes[mode] = {
      rank: rank >= 0 ? rank + 1 : null,
      displayed_rank: displayed >= 0 ? displayed + 1 : null,
      candidates: r.ranked.length,
      coverage: r.displayed.coverage,
      intent: r.intent,
      top: r.ranked[0] ? { target: byId.get(r.ranked[0].page_id), title: r.ranked[0].title } : null,
      // Which arm found it. This is the number that says whether a recall
      // failure is the embedder's fault or the lexicon's.
      lex_rank: hit?.debug?.rrf?.lexical_rank ?? null,
      sem_rank: hit?.debug?.rrf?.semantic_rank ?? null,
      cosine: hit?.debug?.cosine_similarity ?? null,
      fusion_position: hit?.debug?.rerank?.fusion_position ?? null,
      rerank_delta: hit?.debug?.rerank?.delta ?? null,
    };
  }
  rows.push(row);
  process.stdout.write('.');
}
process.stdout.write('\n');

// ---------------------------------------------------------------------------

const at = (n, xs) => xs.filter((r) => r.rank !== null && r.rank <= n).length;
const pct = (n, d) => (d === 0 ? 0 : (100 * n) / d);

function summarise(mode) {
  const rs = rows.map((r) => ({ ...r.modes[mode], type: r.type, id: r.id }));
  const byType = {};
  for (const t of [...new Set(rows.map((r) => r.type))]) {
    const sub = rs.filter((r) => r.type === t);
    byType[t] = {
      n: sub.length,
      'recall@1': +pct(at(1, sub), sub.length).toFixed(1),
      'recall@3': +pct(at(3, sub), sub.length).toFixed(1),
      'recall@5': +pct(at(5, sub), sub.length).toFixed(1),
      'recall@10': +pct(at(10, sub), sub.length).toFixed(1),
      misses: sub.filter((r) => r.rank === null || r.rank > 10).map((r) => r.id),
    };
  }
  const found = rs.filter((r) => r.rank !== null);
  return {
    n: rs.length,
    'recall@1': +pct(at(1, rs), rs.length).toFixed(1),
    'recall@3': +pct(at(3, rs), rs.length).toFixed(1),
    'recall@5': +pct(at(5, rs), rs.length).toFixed(1),
    'recall@10': +pct(at(10, rs), rs.length).toFixed(1),
    mrr: +(rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length).toFixed(4),
    not_retrieved_at_all: rs.filter((r) => r.rank === null).length,
    median_rank_when_found: found.length
      ? found.map((r) => r.rank).sort((a, b) => a - b)[Math.floor(found.length / 2)]
      : null,
    by_type: byType,
  };
}

const summary = Object.fromEntries(MODES.map((m) => [m, summarise(m)]));

// Negatives: how many force a Zone A result. Measured on the SAME run so the
// gate can never be tuned against recall on one index and precision on another.
const negatives = { false_positive_expected: [], honest_weak_match_expected: [] };
for (const bucket of Object.keys(negatives)) {
  for (const q of gold.negatives[bucket]) {
    const r = await rankZoneA(q, { column, rerank: rerankOverride, filters: siteFilter });
    negatives[bucket].push({
      q,
      shown: r.displayed.results.length,
      coverage: r.displayed.coverage,
      top: r.displayed.results[0]
        ? { title: r.displayed.results[0].title, score: +r.displayed.results[0].score.toFixed(6) }
        : null,
    });
  }
  process.stdout.write('.');
}
process.stdout.write('\n');

const drift = await driftGuard([
  'Why do I feel far from God?', 'chiasm in Hebrew writing', 'Ruach HaKodesh and the seal on your identity',
]);

const out = {
  label,
  ran_at: new Date().toISOString(),
  column,
  model_id: models,
  rerank_enabled: rerankOverride === null ? (cfg.rerank_zone_a === 1) : rerankOverride,
  rerank_source: rerankOverride === null ? 'ranking_config' : '--rerank= override',
  rerank_provider: rerankProvider,
  rerank_timeout_ms: Number(process.env.RERANK_TIMEOUT_MS ?? 2000),
  config: Object.fromEntries(
    Object.entries(cfg).filter(([k]) => /^(zone_a_|rrf_k|w_|retrieval_|rerank_|search_mode)/.test(k)),
  ),
  gold_set_version: gold.version,
  summary,
  criteria: {
    '7_recall_at_10_85pct': { got: summary.hybrid['recall@10'], pass: summary.hybrid['recall@10'] >= 85 },
    '8_cross_register_zero_failures': (() => {
      const sub = rows.filter((r) => r.type === 'cross-register').map((r) => r.modes.hybrid);
      const fails = sub.filter((r) => r.rank === null || r.rank > 10).length;
      return { n: sub.length, failures: fails, pass: fails === 0 };
    })(),
    '10_paraphrase_top_5': (() => {
      const sub = rows.filter((r) => r.type === 'paraphrase').map((r) => r.modes.hybrid);
      const ok = sub.filter((r) => r.rank !== null && r.rank <= 5).length;
      return { got: `${ok}/${sub.length}`, pass: ok === sub.length };
    })(),
  },
  negatives_summary: {
    false_positives_shown: negatives.false_positive_expected.filter((n) => n.shown > 0).length,
    false_positives_total: negatives.false_positive_expected.length,
    weak_matches_shown: negatives.honest_weak_match_expected.filter((n) => n.shown > 0).length,
    weak_matches_total: negatives.honest_weak_match_expected.length,
  },
  negatives,
  drift_guard: drift,
  pairs: rows,
};

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/${label}.json`, import.meta.url), JSON.stringify(out, null, 2));

// ---------------------------------------------------------------------------

const w = (s, n) => String(s).padEnd(n);
console.log(`\n${label} — ${models.model_id}, ${models.chunks} chunks in ${models.column}`);

// WHAT ONE PAIR IS WORTH.
//
// 85 pairs means the overall figures move in steps of 1.2 points and the
// paraphrase subset moves in steps of 10. Printed before the table, not after,
// because a reader who sees "+1.1 overall" before seeing this will read a
// decimal that is not there: that movement is ONE PAIR, and one pair is not a
// trend. Report movements as pair counts alongside percentages, and do not call
// a single-pair change a regression or a win.
{
  const sizes = [['overall', rows.length],
    ...Object.entries(summary.hybrid.by_type).map(([t, s]) => [t, s.n])];
  console.log(`\n  one pair is worth:  `
    + sizes.map(([t, n]) => `${t} ${(100 / n).toFixed(1)}pt (n=${n})`).join('   '));
}
// @3 and @5 are here because Zone A renders at most 5 results and only 3 at
// moderate coverage. A model that wins at 10 and loses at 3 is worse for the
// product, and criterion 7's @10 alone would not show it.
console.log(`\n  ${w('', 12)}${w('n', 5)}${w('R@1', 7)}${w('R@3', 7)}${w('R@5', 7)}${w('R@10', 8)}${w('MRR', 9)}miss`);
for (const m of MODES) {
  const s = summary[m];
  console.log(`  ${w(m, 12)}${w(s.n, 5)}${w(s['recall@1'], 7)}${w(s['recall@3'], 7)}${w(s['recall@5'], 7)}`
    + `${w(s['recall@10'], 8)}${w(s.mrr, 9)}${s.n - at(10, rows.map((r) => r.modes[m]))}`);
}
console.log(`\n  hybrid by type:`);
console.log(`    ${w('', 16)}${w('n', 5)}${w('R@3', 12)}${w('R@5', 12)}${w('R@10', 12)}miss`);
for (const [t, s] of Object.entries(summary.hybrid.by_type)) {
  const pc = (v) => `${v} (${Math.round((v / 100) * s.n)}/${s.n})`;
  console.log(`    ${w(t, 16)}${w(s.n, 5)}${w(pc(s['recall@3']), 12)}${w(pc(s['recall@5']), 12)}${w(pc(s['recall@10']), 12)}`
    + `${s.misses.length ? s.misses.join(' ') : ''}`);
}
console.log(`\n  acceptance criteria:`);
for (const [k, v] of Object.entries(out.criteria)) {
  console.log(`    ${v.pass ? 'PASS' : 'FAIL'}  ${w(k, 34)}${JSON.stringify(v)}`);
}
console.log(`\n  negatives: ${out.negatives_summary.false_positives_shown}/${out.negatives_summary.false_positives_total} false positives shown, `
  + `${out.negatives_summary.weak_matches_shown}/${out.negatives_summary.weak_matches_total} weak matches shown`);
console.log(`  drift guard: ${drift.every((d) => d.agree) ? 'agrees with search()' : 'DIVERGED ' + JSON.stringify(drift)}`);
console.log(`\n  written to eval/results/${label}.json`);

await pool.end();
