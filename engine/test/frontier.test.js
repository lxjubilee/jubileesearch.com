// The frontier's freshness rule: link discovery does not refetch a page inside
// the domain's crawl interval; manual and webhook requests may.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.USE_PGLITE = '1';
delete process.env.PGLITE_DIR;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

let pool; let enqueue; let domain;

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
  ({ enqueue } = await import('../src/crawl/frontier.js'));
  const { rows } = await pool.query(
    `INSERT INTO domains (host, tier, status, ingest_mode, crawl_interval_hours, max_depth)
     VALUES ('fresh.example', 'T1', 'active', 'crawl', 24, 5) RETURNING *`);
  domain = rows[0];
  await pool.query(
    `INSERT INTO pages (domain_id, url, url_hash, tier, status, last_fetched_at) VALUES
       ($1, 'https://fresh.example/today', sha256('a'::bytea), 'T1', 'indexed', now() - interval '1 hour'),
       ($1, 'https://fresh.example/stale', sha256('b'::bytea), 'T1', 'indexed', now() - interval '3 days')`,
    [domain.id]);
});
after(async () => { await pool?.end(); });

describe('frontier freshness', () => {
  test('a page fetched an hour ago is not re-queued by link discovery', async () => {
    const r = await enqueue(pool, ['https://fresh.example/today'], domain, { source: 'crawl' });
    assert.equal(r.queued, 0);
    assert.equal(r.skipped_fresh, 1);
  });

  test('a page last fetched three days ago is due again', async () => {
    const r = await enqueue(pool, ['https://fresh.example/stale'], domain, { source: 'crawl' });
    assert.equal(r.queued, 1);
  });

  test('a manual reindex bypasses the interval', async () => {
    const r = await enqueue(pool, ['https://fresh.example/today'], domain, { source: 'manual', priority: 10 });
    assert.equal(r.queued, 1);
  });

  test('a fresh page inside a mixed batch is dropped, the rest queued', async () => {
    await pool.query('DELETE FROM crawl_queue');
    const r = await enqueue(pool, ['https://fresh.example/today', 'https://fresh.example/new'], domain, { source: 'crawl' });
    assert.equal(r.queued, 1);
    const { rows } = await pool.query('SELECT url FROM crawl_queue');
    assert.deepEqual(rows.map((x) => x.url), ['https://fresh.example/new']);
  });
});
