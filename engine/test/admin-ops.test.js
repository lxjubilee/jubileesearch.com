// The admin endpoints added for the console's remaining screens (§15), and the
// §8.2 ownership proofs. Runs against PGlite like database.test.js: every
// migration is applied, then the handlers are called directly with a fake
// identity, which is how server.js calls them once the guard has passed.

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
let ops;
let admin;
const identity = { jubilee_id: 'test-admin', rights: ['search_admin'], authenticated: true };
const url = (path) => new URL(`http://x${path}`);
const find = (routes, method, path) => routes.find((r) => r.method === method && r.match(path));
const call = (route, { path = '/', body = {}, probe } = {}) => route.handle({
  db: pool, identity, url: url(path), body: { parsed: body, probe },
  params: route.params?.(url(path).pathname) ?? {},
});

before(async () => {
  ({ pool } = await import('../src/db.js'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await pool.query(sql);
  }
  ({ routes: ops } = await import('../src/api/routes/admin-ops.js'));
  ({ routes: admin } = await import('../src/api/routes/admin.js'));
});
after(async () => { await pool?.end(); });

describe('§8.2 ownership proofs (crawl/verification.js)', () => {
  test('DNS TXT: passes only on an exact record', async () => {
    const { checkDnsTxt } = await import('../src/crawl/verification.js');
    const resolver = async () => [['jubilee-search-verification=abc'], ['v=spf1 -all']];
    assert.equal((await checkDnsTxt('example.org', 'abc', { resolver })).ok, true);
    assert.equal((await checkDnsTxt('example.org', 'abd', { resolver })).ok, false);
    assert.equal((await checkDnsTxt('example.org', '', { resolver })).ok, false);
  });

  test('DNS TXT: a lookup failure is a miss with the DNS error named', async () => {
    const { checkDnsTxt } = await import('../src/crawl/verification.js');
    const resolver = async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); };
    const r = await checkDnsTxt('nope.example', 'abc', { resolver });
    assert.equal(r.ok, false);
    assert.match(r.reason, /ENOTFOUND/);
  });

  test('well-known: 200 with the token passes; a redirect or a wrong body does not', async () => {
    const { checkWellKnown, wellKnownPath } = await import('../src/crawl/verification.js');
    const seen = [];
    const fetcher = async (u, init) => {
      seen.push([u, init.redirect]);
      if (u.endsWith(wellKnownPath('tok'))) return { status: 200, text: async () => 'tok\n' };
      if (u.includes('redir')) return { status: 302, text: async () => '' };
      return { status: 200, text: async () => 'something else' };
    };
    assert.equal((await checkWellKnown('example.org', 'tok', { fetcher })).ok, true);
    assert.equal(seen[0][1], 'manual', 'redirects are never followed');
    assert.equal((await checkWellKnown('example.org', 'other', { fetcher })).ok, false);
    assert.equal((await checkWellKnown('redir.example', 'redir', { fetcher })).ok, false);
  });
});

describe('domains: edit, pause, reingest, import, verification token', () => {
  let id;
  before(async () => {
    const { rows } = await pool.query(
      `INSERT INTO domains (host, tier, status, ingest_mode) VALUES ('edit.example', 'T2', 'active', 'crawl')
       RETURNING id`);
    id = Number(rows[0].id);
  });

  test('PUT edits only the editable columns and drops Zone A when the tier leaves T1', async () => {
    const route = find(ops, 'PUT', `/api/v1/admin/domains/${id}`);
    const r = await call(route, { path: `/api/v1/admin/domains/${id}`,
      body: { display_name: 'Edited', crawl_interval_hours: '48', sitemap_urls: 'https://a/x.xml, https://a/y.xml' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.display_name, 'Edited');
    assert.equal(Number(r.body.crawl_interval_hours), 48);
    const { rows } = await pool.query('SELECT sitemap_urls FROM domains WHERE id = $1', [id]);
    assert.deepEqual(rows[0].sitemap_urls, ['https://a/x.xml', 'https://a/y.xml']);

    await assert.rejects(() => call(route, { path: `/api/v1/admin/domains/${id}`, body: { max_depth: -1 } }), /non-negative/);
    await assert.rejects(() => call(route, { path: `/api/v1/admin/domains/${id}`, body: {} }), /nothing to change/);
  });

  test('pause and resume flip status, and a blocked domain cannot be resumed', async () => {
    const route = find(ops, 'POST', `/api/v1/admin/domains/${id}/pause`);
    let r = await call(route, { path: `/api/v1/admin/domains/${id}/pause`, body: { paused: true } });
    assert.equal(r.body.status, 'paused');
    r = await call(route, { path: `/api/v1/admin/domains/${id}/pause`, body: { paused: false } });
    assert.equal(r.body.status, 'active');
    await pool.query(`UPDATE domains SET status = 'blocked' WHERE id = $1`, [id]);
    await assert.rejects(() => call(route, { path: `/api/v1/admin/domains/${id}/pause`, body: { paused: false } }), /blocked/);
    await pool.query(`UPDATE domains SET status = 'active' WHERE id = $1`, [id]);
  });

  test('reingest forgets every content hash and makes the domain due now', async () => {
    await pool.query(
      `INSERT INTO pages (domain_id, url, url_hash, tier, status, content_hash)
       VALUES ($1, 'https://edit.example/a', sha256('a'::bytea), 'T2', 'indexed', sha256('body'::bytea))`, [id]);
    const route = find(ops, 'POST', `/api/v1/admin/domains/${id}/reingest`);
    const r = await call(route, { path: `/api/v1/admin/domains/${id}/reingest` });
    assert.equal(r.body.pages_reset, 1);
    const { rows } = await pool.query(
      `SELECT content_hash, (SELECT next_crawl_due <= now() FROM domains WHERE id = $1) AS due
         FROM pages WHERE domain_id = $1`, [id]);
    assert.equal(rows[0].content_hash, null);
    assert.equal(rows[0].due, true);
  });

  test('bulk import accepts CSV, lands rows as pending, and reports per-row failures', async () => {
    const route = find(ops, 'POST', '/api/v1/admin/domains/import');
    const csv = ['host,tier,display_name', 'one.example,T2,"One, Inc"', 'two.example,T3,Two', 'bad.example,T9,Bad'].join('\n');
    const r = await call(route, { body: { csv } });
    assert.equal(r.body.total, 3);
    assert.equal(r.body.inserted, 2);
    assert.equal(r.body.failed, 1);
    assert.match(r.body.results[2].error, /tier/);
    const { rows } = await pool.query(`SELECT status, display_name FROM domains WHERE host = 'one.example'`);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].display_name, 'One, Inc');
    // Importing again updates rather than duplicating.
    const again = await call(route, { body: { rows: [{ host: 'one.example', tier: 'T2' }] } });
    assert.equal(again.body.updated, 1);
  });

  test('a verification token is issued for T1 only, and the proof must match it', async () => {
    const { rows } = await pool.query(
      `INSERT INTO domains (host, tier, status) VALUES ('owned.example', 'T1', 'pending') RETURNING id`);
    const t1 = Number(rows[0].id);
    const issue = find(ops, 'POST', `/api/v1/admin/domains/${t1}/verification-token`);
    await assert.rejects(() => call(issue, { path: `/api/v1/admin/domains/${id}/verification-token` }), /T1/);
    const issued = await call(issue, { path: `/api/v1/admin/domains/${t1}/verification-token` });
    assert.match(issued.body.dns_txt, /^jubilee-search-verification=/);
    const token = issued.body.token;

    const verify = find(admin, 'POST', `/api/v1/admin/domains/${t1}/verify`);
    const wrong = await call(verify, { path: `/api/v1/admin/domains/${t1}/verify`,
      body: { method: 'dns_txt' }, probe: { resolver: async () => [['jubilee-search-verification=nope']] } });
    assert.equal(wrong.status, 422);
    let { rows: d } = await pool.query('SELECT zone_a_eligible FROM domains WHERE id = $1', [t1]);
    assert.equal(d[0].zone_a_eligible, false, 'a failed proof grants nothing');

    const right = await call(verify, { path: `/api/v1/admin/domains/${t1}/verify`,
      body: { method: 'dns_txt' }, probe: { resolver: async () => [[`jubilee-search-verification=${token}`]] } });
    assert.equal(right.status, 200);
    ({ rows: d } = await pool.query('SELECT zone_a_eligible, verification_method FROM domains WHERE id = $1', [t1]));
    assert.equal(d[0].zone_a_eligible, true);
    assert.equal(d[0].verification_method, 'dns_txt');
  });
});

describe('best bets: update, reorder, audit', () => {
  let a; let b;
  before(async () => {
    const mk = async (pat, pos) => Number((await pool.query(
      `INSERT INTO best_bets (match_type, pattern, target_url, position, created_by)
       VALUES ('exact', $1, 'https://x/' || $1, $2, 'seed') RETURNING id`, [pat, pos])).rows[0].id);
    a = await mk('alpha', 1);
    b = await mk('beta', 2);
  });

  test('PUT changes the schedule and blurb, refuses an inverted window, and audits before/after', async () => {
    const route = find(ops, 'PUT', `/api/v1/admin/best-bets/${a}`);
    const r = await call(route, { path: `/api/v1/admin/best-bets/${a}`,
      body: { blurb: 'Hello', starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' } });
    assert.equal(r.body.blurb, 'Hello');
    assert.ok(r.body.starts_at);
    await assert.rejects(() => call(route, { path: `/api/v1/admin/best-bets/${a}`,
      body: { starts_at: '2026-03-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' } }), /before/);
    const { rows } = await pool.query(
      `SELECT action, before_state->>'blurb' AS before, after_state->>'blurb' AS after
         FROM best_bet_audit WHERE best_bet_id = $1 ORDER BY id DESC LIMIT 1`, [a]);
    assert.deepEqual(rows[0], { action: 'update', before: null, after: 'Hello' });
  });

  test('reorder assigns positions from the list and logs only real moves', async () => {
    const route = find(ops, 'POST', '/api/v1/admin/best-bets/reorder');
    const beforeCount = Number((await pool.query('SELECT count(*) AS n FROM best_bet_audit')).rows[0].n);
    const r = await call(route, { body: { order: [b, a] } });
    assert.equal(r.body.reordered, 2);
    const { rows } = await pool.query('SELECT id, position FROM best_bets WHERE id = ANY($1) ORDER BY position', [[a, b]]);
    assert.deepEqual(rows.map((x) => Number(x.id)), [b, a]);
    const afterCount = Number((await pool.query('SELECT count(*) AS n FROM best_bet_audit')).rows[0].n);
    assert.equal(afterCount - beforeCount, 2);
    await assert.rejects(() => call(route, { body: { order: ['x'] } }), /list of ids/);
  });

  test('the audit log is readable, newest first, optionally per bet', async () => {
    const route = find(ops, 'GET', '/api/v1/admin/best-bets/audit');
    const all = await call(route, { path: '/api/v1/admin/best-bets/audit?limit=5' });
    assert.ok(all.body.entries.length >= 3);
    const one = await call(route, { path: `/api/v1/admin/best-bets/audit?id=${b}` });
    assert.ok(one.body.entries.every((e) => Number(e.best_bet_id) === b));
  });
});

describe('lexicon: import and preview', () => {
  test('import creates concepts on first sight, upserts terms, and names the article rule', async () => {
    const route = find(ops, 'POST', '/api/v1/admin/lexicon/import');
    const csv = [
      'concept_key,gloss,term,lang,weight,is_primary',
      'ruach_test,Spirit,ruach test,en,1,true',
      'ruach_test,,spirit test,en,0.8,false',
      'ruach_test,,the ruach hakodesh test,en,1,false',
    ].join('\n');
    const r = await call(route, { body: { csv } });
    assert.equal(r.body.concepts_created, 1);
    assert.equal(r.body.terms_written, 2);
    assert.equal(r.body.failed, 1);
    assert.match(r.body.errors[0].error, /Ha- prefix/);
  });

  test('preview expands a sample query exactly as the pipeline would', async () => {
    const route = find(ops, 'GET', '/api/v1/admin/lexicon/preview');
    const r = await call(route, { path: '/api/v1/admin/lexicon/preview?q=ruach%20test&lang=en' });
    assert.equal(r.body.lang, 'en');
    assert.ok(r.body.concepts.includes('ruach_test'));
    assert.ok(r.body.groups.some((g) => g.terms.includes('spirit')) || r.body.groups.length > 0);
    await assert.rejects(() => call(route, { path: '/api/v1/admin/lexicon/preview?q=' }), /q is required/);
  });
});

describe('index tools: reindex, purge a page, re-embed, log', () => {
  let did; let pid;
  before(async () => {
    const { rows } = await pool.query(
      `INSERT INTO domains (host, tier, status, ingest_mode) VALUES ('tools.example', 'T2', 'active', 'crawl') RETURNING id`);
    did = Number(rows[0].id);
    const { rows: p } = await pool.query(
      `INSERT INTO pages (domain_id, url, url_hash, tier, status, content_hash)
       VALUES ($1, 'https://tools.example/p', sha256('p'::bytea), 'T2', 'indexed', sha256('x'::bytea)) RETURNING id`, [did]);
    pid = Number(p[0].id);
    await pool.query(
      `INSERT INTO chunks (page_id, ordinal, text, embedded_at) VALUES ($1, 0, 'chunk', now())`, [pid]);
    await pool.query(
      `INSERT INTO ingest_runs (domain_id, mode) VALUES ($1, 'crawl')`, [did]);
  });

  test('reindex of one page resets its hash and queues it; of a host resets them all', async () => {
    const route = find(ops, 'POST', '/api/v1/admin/index/reindex');
    const one = await call(route, { body: { url: 'https://tools.example/p' } });
    assert.equal(one.body.pages_reset, 1);
    const all = await call(route, { body: { host: 'tools.example' } });
    assert.equal(all.body.pages_reset, 1);
    await assert.rejects(() => call(route, { body: { url: 'https://tools.example/none' } }), /no such page/);
    await assert.rejects(() => call(route, { body: {} }), /url or host/);
  });

  test('re-embed clears the vectors so the embed job picks the chunks up again', async () => {
    const route = find(ops, 'POST', '/api/v1/admin/index/reembed');
    const r = await call(route, { body: { url: 'https://tools.example/p' } });
    assert.equal(r.body.chunks_reset, 1);
    const { rows } = await pool.query('SELECT embedded_at FROM chunks WHERE page_id = $1', [pid]);
    assert.equal(rows[0].embedded_at, null);
  });

  test('the log gathers ingest runs, failures and queue state for a URL', async () => {
    const route = find(ops, 'GET', '/api/v1/admin/index/log');
    const r = await call(route, { path: '/api/v1/admin/index/log?url=https://tools.example/p' });
    assert.equal(r.body.domain.host, 'tools.example');
    assert.equal(r.body.ingest_runs.length, 1);
    assert.ok(Array.isArray(r.body.queue));
    await assert.rejects(() => call(route, { path: '/api/v1/admin/index/log?url=notaurl' }), /absolute/);
  });

  test('purging a page deletes it and bumps the index version', async () => {
    const before = Number((await pool.query('SELECT version FROM index_version')).rows[0].version);
    const route = find(ops, 'POST', '/api/v1/admin/index/purge-page');
    await call(route, { body: { url: 'https://tools.example/p' } });
    const { rows } = await pool.query('SELECT count(*) AS n FROM pages WHERE id = $1', [pid]);
    assert.equal(Number(rows[0].n), 0);
    const after = Number((await pool.query('SELECT version FROM index_version')).rows[0].version);
    assert.ok(after > before);
    await assert.rejects(() => call(route, { body: { url: 'https://tools.example/p' } }), /no such page/);
  });
});

describe('analytics overview', () => {
  test('answers the five panels the screen was missing', async () => {
    await pool.query(
      `INSERT INTO search_queries (query_text, normalized, intent, lang, zone_a_count, zone_b_count)
       VALUES ('grace', 'grace', 'topical', 'en', 0, 3), ('grace', 'grace', 'topical', 'en', 2, 3),
              ('psalm 23', 'psalm 23', 'scripture', 'en', 1, 0)`);
    const route = find(ops, 'GET', '/api/v1/admin/analytics/overview');
    const r = await call(route, { path: '/api/v1/admin/analytics/overview?days=7' });
    const topical = r.body.by_intent.find((x) => x.intent === 'topical');
    assert.equal(Number(topical.searches), 2);
    assert.equal(r.body.by_language[0].lang, 'en');
    assert.equal(r.body.top_queries[0].normalized, 'grace');
    assert.equal(Number(r.body.top_queries[0].zone_a_empty), 1);
    assert.ok(Array.isArray(r.body.ctr_by_position));
    assert.ok(Array.isArray(r.body.concept_hits));
  });
});
