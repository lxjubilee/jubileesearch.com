// The content-gap report (jobs/content-gap.js): three lists from the query log.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.USE_PGLITE = '1';
delete process.env.PGLITE_DIR;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

let pool; let buildContentGapReport; let reportToCsv; let reportToCsvFiles; let reportToText; let reportToHtml; let deliver;

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
  ({ buildContentGapReport, reportToCsv, reportToCsvFiles, reportToText, reportToHtml, deliver } = await import('../src/jobs/content-gap.js'));

  // Demand with no answer at all (3x), demand the network missed (2x), one-off noise (1x).
  await pool.query(
    `INSERT INTO search_queries (query_text, normalized, intent, lang, zone_a_count, zone_b_count) VALUES
       ('tithing', 'tithing', 'topical', 'en', 0, 0), ('tithing', 'tithing', 'topical', 'en', 0, 0), ('Tithing', 'tithing', 'topical', 'en', 0, 0),
       ('sabbath candles', 'sabbath candles', 'topical', 'en', 0, 4), ('sabbath candles', 'sabbath candles', 'topical', 'en', 0, 4),
       ('once only', 'once only', 'topical', 'en', 0, 0),
       ('grace', 'grace', 'topical', 'en', 3, 3)`);
  // A Zone A that was shown 20 times and never clicked.
  const { rows: [d] } = await pool.query(`INSERT INTO domains (host, tier, status) VALUES ('g.example', 'T1', 'active') RETURNING id`);
  const { rows: [p] } = await pool.query(
    `INSERT INTO pages (domain_id, url, url_hash, tier, status) VALUES ($1, 'https://g.example/a', sha256('a'::bytea), 'T1', 'indexed') RETURNING id`, [d.id]);
  for (let i = 0; i < 20; i += 1) {
    const { rows: [q] } = await pool.query(
      `INSERT INTO search_queries (query_text, normalized, intent, lang, zone_a_count, zone_b_count)
       VALUES ('grace', 'grace', 'topical', 'en', 3, 3) RETURNING id`);
    await pool.query(
      `INSERT INTO result_impressions (query_id, page_id, zone, position, clicked) VALUES ($1, $2, 'A', 1, FALSE)`, [q.id, p.id]);
  }
});
after(async () => { await pool?.end(); });

describe('content-gap report', () => {
  test('zero-result demand appears once it recurs; one-offs do not', async () => {
    const r = await buildContentGapReport(pool, { days: 7 });
    assert.deepEqual(r.zero_result.map((x) => [x.query, Number(x.times)]), [['tithing', 3]]);
  });

  test('queries the wider web answered but the network did not are their own list', async () => {
    const r = await buildContentGapReport(pool, { days: 7 });
    assert.deepEqual(r.zone_a_empty.map((x) => x.query), ['sabbath candles']);
  });

  test('a Zone A shown often and never clicked is a low-CTR gap', async () => {
    const r = await buildContentGapReport(pool, { days: 7, minImpressions: 20 });
    assert.equal(r.low_ctr.length, 1);
    assert.equal(r.low_ctr[0].query, 'grace');
    assert.equal(Number(r.low_ctr[0].impressions), 20);
  });

  test('the e-mail carries the top of each list and the CSV as an attachment', async () => {
    const report = await buildContentGapReport(pool, { days: 7 });
    const text = reportToText(report);
    assert.match(text, /Nothing came back \(1\)/);
    assert.match(text, /tithing \(en\)  x3/);
    assert.match(text, /The wider web answered, Jubilee did not \(1\)/);
    const sent = [];
    const r = await deliver(report, { recipients: ['editor@example.org'], send: async (m) => { sent.push(m); return { success: true, provider: 'test', id: 'x' }; } });
    assert.equal(r.sent, true);
    assert.equal(sent[0].to[0], 'editor@example.org');
    assert.match(sent[0].subject, /content-gap report/);
    assert.deepEqual(sent[0].attachments.map((a) => a.filename),
      ['all-searches.csv', 'nothing-came-back.csv', 'wider-web-answered.csv', 'shown-not-clicked.csv']);
    assert.ok(sent[0].attachments.every((a) => a.type === 'text/csv'));
    assert.match(sent[0].html, /<html/);
    assert.match(sent[0].html, /Nothing came back/);
  });

  test('all-searches.csv carries every search in the period, not only the ones past a threshold', async () => {
    const report = await buildContentGapReport(pool, { days: 7 });
    const files = reportToCsvFiles(report);
    const rows = files['all-searches.csv'].trim().split('\n');
    assert.equal(rows[0], 'query,lang,intent,times,outcome,zone_a_results,zone_b_results,cache_hits,avg_latency_ms,first_seen,last_seen');
    // One row per distinct (query, lang, intent); the `times` column sums to the total.
    assert.equal(rows.length - 1, Number(report.totals.distinct_queries));
    const times = rows.slice(1).reduce((n, r) => n + Number(r.split(',')[3]), 0);
    assert.equal(times, Number(report.totals.searches));
    assert.match(files['all-searches.csv'], /^once only,en,topical,1,nothing came back,/m);
    assert.match(files['all-searches.csv'], /^sabbath candles,en,topical,2,wider web only,/m);
    assert.match(files['all-searches.csv'], /^grace,en,topical,21,answered,/m);
  });

  test('each category CSV has exactly the rows the mail counts, and an empty one keeps its header', async () => {
    const report = await buildContentGapReport(pool, { days: 7 });
    const files = reportToCsvFiles(report);
    const dataRows = (name) => files[name].trim().split('\n').length - 1;
    assert.equal(dataRows('nothing-came-back.csv'), report.zero_result.length);
    assert.equal(dataRows('wider-web-answered.csv'), report.zone_a_empty.length);
    assert.equal(dataRows('shown-not-clicked.csv'), report.low_ctr.length);
    assert.match(files['nothing-came-back.csv'], /^query,lang,intent,times,last_seen\ntithing,en,topical,3,/);
    assert.match(files['shown-not-clicked.csv'], /^query,impressions,clicks,ctr\ngrace,20,0,0/);

    const empty = { ...report, zero_result: [], zone_a_empty: [], low_ctr: [] };
    const emptyFiles = reportToCsvFiles(empty);
    assert.equal(emptyFiles['nothing-came-back.csv'], 'query,lang,intent,times,last_seen\n');
    assert.equal(emptyFiles['shown-not-clicked.csv'], 'query,impressions,clicks,ctr\n');
    assert.match(reportToText(empty), /Nothing came back \(0\)\n  .*\n  No searches crossed this threshold/);
    assert.match(reportToHtml(empty), /attached with headers only/);
    // The total still counts every search even when no category has rows.
    assert.match(reportToText(empty), new RegExp(`Total searches: ${report.totals.searches}$`, 'm'));
  });

  test('the HTML body shows the same numbers as the text body and the CSVs', async () => {
    const report = await buildContentGapReport(pool, { days: 7 });
    const html = reportToHtml(report);
    const text = reportToText(report);
    assert.match(text, new RegExp(`Total searches: ${report.totals.searches}$`, 'm'));
    assert.match(html, new RegExp(`>${report.totals.searches}<`));
    assert.match(html, /Nothing came back<\/td>[\s\S]*?>1 term</);
    assert.match(html, />tithing</);
    assert.match(html, /href="https:\/\/jubileesearch\.com\/admin\/analytics"/);
    assert.match(html, /<meta name="viewport"/);
    assert.doesNotMatch(html, /undefined|NaN/);
    assert.doesNotMatch(text, /undefined|NaN/);
  });

  test('no recipients means no send, and the job still succeeds', async () => {
    const report = await buildContentGapReport(pool, { days: 7 });
    const r = await deliver(report, { recipients: [], send: async () => { throw new Error('must not be called'); } });
    assert.equal(r.sent, false);
  });

  test('totals and thresholds travel with the report, and the CSV is one file', async () => {
    const r = await buildContentGapReport(pool, { days: 7 });
    assert.ok(Number(r.totals.searches) >= 26);
    assert.equal(r.thresholds.low_ctr_below, 0.05);
    // The e-mail's headline count reads totals.searches; a renamed column
    // once rendered as "undefined searches".
    assert.match(reportToText(r), new RegExp(`Total searches: ${r.totals.searches}$`, 'm'));
    const csv = reportToCsv(r);
    assert.match(csv.split('\n')[0], /^kind,query,lang/);
    assert.match(csv, /zero_result,tithing/);
    assert.match(csv, /zone_a_empty,sabbath candles/);
    assert.match(csv, /low_ctr,grace/);
  });
});
