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

let pool; let buildContentGapReport; let reportToCsv;

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
  ({ buildContentGapReport, reportToCsv } = await import('../src/jobs/content-gap.js'));

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

  test('totals and thresholds travel with the report, and the CSV is one file', async () => {
    const r = await buildContentGapReport(pool, { days: 7 });
    assert.ok(Number(r.totals.searches) >= 26);
    assert.equal(r.thresholds.low_ctr_below, 0.05);
    const csv = reportToCsv(r);
    assert.match(csv.split('\n')[0], /^kind,query,lang/);
    assert.match(csv, /zero_result,tithing/);
    assert.match(csv, /zone_a_empty,sabbath candles/);
    assert.match(csv, /low_ctr,grace/);
  });
});
