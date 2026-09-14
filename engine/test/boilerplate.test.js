// Migration 036: chunks whose text recurs across a domain's pages are
// boilerplate -- flagged, stripped of their vector, and never offered to the
// embed job or to retrieval again.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.USE_PGLITE = '1';
delete process.env.PGLITE_DIR;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

let pool;
let ids;

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDir, file), 'utf8'));

  const { rows: [d] } = await pool.query(
    `INSERT INTO domains (host, tier, status) VALUES ('tpl.example', 'T1', 'active') RETURNING id`);
  const { rows: [other] } = await pool.query(
    `INSERT INTO domains (host, tier, status) VALUES ('other.example', 'T1', 'active') RETURNING id`);
  ids = { domain: d.id, other: other.id, pages: [] };
  const vec = `[${new Array(1024).fill(0.001).join(',')}]`;
  for (let i = 0; i < 3; i += 1) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO pages (domain_id, url, url_hash, tier, status) VALUES ($1, $2, sha256(convert_to($2, 'UTF8')), 'T1', 'indexed') RETURNING id`,
      [ids.domain, `https://tpl.example/p${i}`]);
    ids.pages.push(p.id);
    await pool.query(
      `INSERT INTO chunks (page_id, ordinal, text, embedding, embedded_at) VALUES
         ($1, 0, 'Related messages: Teaching My Children 10 min Imani Isaiah 58:12', $2::halfvec, now()),
         ($1, 1, $3, $2::halfvec, now())`,
      [p.id, vec, `Unique article body number ${i} about teshuvah and returning.`]);
  }
  // The same menu text on ANOTHER domain, on one page only: not repeated there.
  const { rows: [q] } = await pool.query(
    `INSERT INTO pages (domain_id, url, url_hash, tier, status) VALUES ($1, 'https://other.example/x', sha256('x'::bytea), 'T1', 'indexed') RETURNING id`,
    [ids.other]);
  await pool.query(
    `INSERT INTO chunks (page_id, ordinal, text, embedding, embedded_at)
     VALUES ($1, 0, 'Related messages: Teaching My Children 10 min Imani Isaiah 58:12', $2::halfvec, now())`, [q.id, vec]);
});
after(async () => { await pool?.end(); });

describe('boilerplate chunks (migration 036)', () => {
  test('text repeated on three pages of one domain is flagged and loses its vector', async () => {
    const { rows: [{ marked }] } = await pool.query('SELECT mark_boilerplate_chunks(3) AS marked');
    assert.equal(Number(marked), 3);
    const { rows } = await pool.query(
      `SELECT ordinal, boilerplate, embedding IS NULL AS no_vector, embedded_at IS NULL AS pending
         FROM chunks WHERE page_id = ANY($1::bigint[]) ORDER BY page_id, ordinal`, [ids.pages]);
    for (const r of rows) {
      if (r.ordinal === 0) { assert.equal(r.boilerplate, true); assert.equal(r.no_vector, true); }
      else { assert.equal(r.boilerplate, false); assert.equal(r.no_vector, false); }
    }
  });

  test('the same text on a single page of another domain is content there', async () => {
    const { rows } = await pool.query(
      `SELECT c.boilerplate FROM chunks c JOIN pages p ON p.id = c.page_id WHERE p.domain_id = $1`, [ids.other]);
    assert.equal(rows[0].boilerplate, false);
  });

  test('marking is idempotent', async () => {
    const { rows: [{ marked }] } = await pool.query('SELECT mark_boilerplate_chunks(3) AS marked');
    assert.equal(Number(marked), 0);
  });

  test('the embed job never claims a boilerplate chunk', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM chunks WHERE embedded_at IS NULL AND NOT boilerplate`);
    assert.equal(Number(rows[0].n), 0, 'nothing pending: the flagged chunks are excluded by the same predicate the job uses');
  });
});
