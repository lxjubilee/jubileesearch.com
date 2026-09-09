// Database-backed tests, against PGlite.
//
// Everything else in the suite is a pure function or an HTTP client. This file
// runs the migrations and then exercises the SQL, in memory, with no server to
// install — so "the SQL has never been executed" stops being true on every
// `npm test` rather than only when someone remembers to point the engine at a
// database.
//
// It is not a substitute for running against real Postgres before release. See
// `src/db-pglite.js` for what PGlite does not do: no concurrency, so
// `FOR UPDATE SKIP LOCKED` cannot be shown to work, and none of the operational
// behaviour that makes `UNLOGGED` or a backup meaningful.
//
// Two bugs are pinned here that only execution could have found:
//   * /suggest ordered a UNION by an expression, which Postgres rejects outright
//   * every numeric bind parameter in the retrieval query needs an explicit
//     cast, or a weight of 0.15 is resolved against `integer` and rejected

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.USE_PGLITE = '1';
process.env.NODE_ENV = 'test';
delete process.env.PGLITE_DIR;            // in memory, discarded at the end
process.env.INFERENCE_API_URL = '';       // no vector path, no rerank

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

let pool;
let search;
let suggestRoute;

before(async () => {
  ({ pool } = await import('../src/db.js'));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }

  ({ search } = await import('../src/query/orchestrator.js'));
  const { routes } = await import('../src/api/routes/public.js');
  suggestRoute = routes.find((r) => r.match('/api/v1/suggest'));

  await seedContent();
});

after(async () => { await pool?.end(); });

// A handful of pages written the way the ingest path writes them, so the
// tsvector trigger, the chunk table and the serving views are all exercised.
async function seedContent() {
  const { upsertPage } = await import('../src/ingest/service.js');
  const { mapToPage } = await import('../src/ingest/markdown.js');

  const { rows } = await pool.query(
    `UPDATE domains SET zone_a_eligible = TRUE, status = 'active',
                        url_template = 'https://{host}/{slug}'
      WHERE host = 'jubileeverse.com' RETURNING *`);
  const domain = rows[0];

  const articles = [
    ['ruach.md', 'The Ruach HaKodesh', `${'The Ruach HaKodesh is given, not earned, and the giving is the whole of it. '.repeat(12)}`],
    ['teshuvah.md', 'Teshuvah as returning', `${'Teshuvah is a turning and a returning, and it is never finished in one sitting. '.repeat(12)}`],
    ['shabbat.md', 'Keeping Shabbat', `${'Shabbat is not an absence of work but a presence of rest, kept rather than taken. '.repeat(12)}`],
  ];

  for (const [path, title, body] of articles) {
    const source = `---\ntitle: ${JSON.stringify(title)}\nslug: ${path.replace('.md', '')}\nlanguage: en\ncategory: Teaching\n---\n\n# ${title}\n\n${body}\n`;
    const mapped = mapToPage(source, domain, path);
    await upsertPage(domain, mapped, source);
  }
}

describe('schema', () => {
  test('every migration applies', async () => {
    // `before` throws on the first failure, so reaching here means all of them
    // ran. This asserts the shape that resulted.
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    assert.ok(Number(rows[0].n) >= 25, `only ${rows[0].n} tables`);
  });

  test('the chunk embedding column is halfvec(1024)', async () => {
    const { rows } = await pool.query(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`);
    assert.equal(rows[0].t, 'halfvec(1024)');
  });

  test('the HNSW index is split by zone', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'chunks_embedding%' ORDER BY indexname`);
    assert.deepEqual(rows.map((r) => r.indexname),
      ['chunks_embedding_zone_a', 'chunks_embedding_zone_b']);
  });

  test('the doubled-article constraint rejects at write time', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO lexicon_terms (concept_id, term, lang)
         SELECT id, 'the ruach hakodesh', 'en' FROM lexicon_concepts WHERE concept_key = 'ruach_hakodesh'`),
      /lexicon_terms_no_doubled_article|violates check constraint/);
  });

  test('a non-T1 domain cannot be made Zone A eligible', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO domains (host, tier, zone_a_eligible) VALUES ('x.example', 'T3', TRUE)`),
      /domains_zone_a_requires_t1|violates check constraint/);
  });

  test('changing a ranking weight bumps the index version', async () => {
    const before = await pool.query('SELECT version FROM index_version WHERE id');
    await pool.query(`UPDATE ranking_config SET value = 0.16, updated_by = 'test' WHERE key = 'w_quality'`);
    const after = await pool.query('SELECT version FROM index_version WHERE id');
    assert.ok(Number(after.rows[0].version) > Number(before.rows[0].version),
      'the cache would keep serving results scored under the old weights');
    await pool.query(`UPDATE ranking_config SET value = 0.15, updated_by = 'test' WHERE key = 'w_quality'`);
  });
});

describe('serving views enforce P1', () => {
  test('a T3 page without a safe verdict is not servable', async () => {
    await pool.query(
      `INSERT INTO domains (host, tier, status) VALUES ('open.example', 'T3', 'active')
       ON CONFLICT (host) DO NOTHING`);
    for (const [url, verdict] of [['https://open.example/a', 'safe'],
                                  ['https://open.example/b', 'review'],
                                  ['https://open.example/c', null],
                                  ['https://open.example/d', 'unsafe']]) {
      await pool.query(
        `INSERT INTO pages (domain_id, url, url_hash, status, tier, title, body_text, safety_verdict)
         SELECT id, $1, sha256(convert_to($1,'UTF8')), 'indexed', 'T3', 'x', 'body text here', $2
           FROM domains WHERE host = 'open.example'
         ON CONFLICT (domain_id, url_hash) DO UPDATE SET safety_verdict = EXCLUDED.safety_verdict`,
        [url, verdict]);
    }

    const { rows } = await pool.query(
      `SELECT url FROM servable_pages WHERE tier = 'T3' ORDER BY url`);
    assert.deepEqual(rows.map((r) => r.url), ['https://open.example/a'],
      'acceptance criterion 21: only safe T3 pages may be servable');
  });

  test('a suppressed page leaves the index immediately', async () => {
    await pool.query(`UPDATE pages SET suppressed = TRUE WHERE url = 'https://open.example/a'`);
    const { rows } = await pool.query(`SELECT count(*) AS n FROM servable_pages WHERE tier = 'T3'`);
    assert.equal(Number(rows[0].n), 0);
    await pool.query(`UPDATE pages SET suppressed = FALSE WHERE url = 'https://open.example/a'`);
  });

  test('Zone A holds only verified T1 pages', async () => {
    const { rows } = await pool.query(`
      SELECT count(*) AS n FROM zone_a_pages p
       WHERE p.tier <> 'T1'
          OR NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = p.domain_id AND d.zone_a_eligible)`);
    assert.equal(Number(rows[0].n), 0, 'acceptance criterion 11');
  });
});

describe('the query pipeline, executed', () => {
  test('a search returns Zone A results', async () => {
    const result = await search({ q: 'shabbat rest' });
    assert.ok(result.zone_a.results.length > 0, 'no Zone A results');
    assert.equal(result.zone_a.label, 'From Jubilee');
    assert.equal(result.zone_a.results[0].tier, 'T1');
    assert.ok(result.query_id, 'the query was not logged');
  });

  test('every numeric ranking weight survives parameter binding', async () => {
    // The bug this pins: `$1 * (CASE ... THEN 1 ELSE 0 END)` resolves the
    // parameter against `integer`, so a weight of 0.15 is rejected outright.
    // Every weight is non-integral, so any regression fails this immediately.
    const { rows } = await pool.query(
      `SELECT key, value FROM ranking_config WHERE value <> round(value)`);
    assert.ok(rows.length >= 5, 'expected several fractional weights');
    const result = await search({ q: 'teshuvah', debug: true });
    assert.ok(result.debug, 'debug payload missing');
    assert.equal(typeof result.zone_a.results[0]?.score, 'number');
  });

  test('register bridging finds the other register (acceptance 8)', async () => {
    // "holy spirit" must reach a page that only ever says "Ruach HaKodesh".
    const result = await search({ q: 'holy spirit' });
    const urls = result.zone_a.results.map((r) => r.url);
    assert.ok(urls.some((u) => u.includes('ruach')),
      `expected the Ruach HaKodesh page, got ${JSON.stringify(urls)}`);
  });

  test('the reverse direction works too', async () => {
    const result = await search({ q: 'ruach hakodesh' });
    assert.ok(result.zone_a.results.length > 0);
  });

  test('an unmatched query gets the honest empty state, not padding', async () => {
    const result = await search({ q: 'xyzzy plugh quuux' });
    assert.equal(result.zone_a.results.length, 0);
    assert.equal(result.zone_a.coverage, 'none');
    assert.equal(result.zone_a.empty_state, true);
  });

  test('impressions are logged for every rendered result', async () => {
    const result = await search({ q: 'shabbat' });
    const { rows } = await pool.query(
      'SELECT zone, position FROM result_impressions WHERE query_id = $1 ORDER BY zone, position',
      [result.query_id]);
    assert.equal(rows.length, result.zone_a.results.length + result.zone_b.results.length);
    assert.equal(rows[0].zone, 'A');
    assert.equal(Number(rows[0].position), 1);
  });

  test('a repeated query is served from the cache and still logs impressions', async () => {
    const first = await search({ q: 'keeping shabbat rest' });
    const second = await search({ q: 'keeping shabbat rest' });
    assert.equal(first.cache_hit, false);
    assert.equal(second.cache_hit, true);
    assert.notEqual(first.query_id, second.query_id, 'a cache hit must still log its own query');

    const { rows } = await pool.query(
      'SELECT count(*) AS n FROM result_impressions WHERE query_id = $1', [second.query_id]);
    assert.ok(Number(rows[0].n) > 0, 'a cache hit logged no impressions');
  });

  test('the scripture router reports its intent', async () => {
    const result = await search({ q: 'john 3:16', debug: true });
    assert.equal(result.debug.intent, 'scripture');
    assert.equal(result.debug.scripture_reference, 'John 3:16');
    // No JSV API configured, so no card -- and silence is correct (§13.2).
    assert.equal(result.scripture_card, null);
  });
});

describe('/suggest', () => {
  // Pins the bug: Postgres rejects an expression in the ORDER BY of a set
  // operation with "invalid UNION/INTERSECT/EXCEPT ORDER BY clause". The union
  // has to be wrapped in a subquery and ordered outside.
  test('the union query is valid SQL and returns suggestions', async () => {
    await search({ q: 'shabbat' });   // give the popular-queries branch a row

    const result = await suggestRoute.handle({
      url: new URL('http://x/api/v1/suggest?q=shab'),
      db: pool,
    });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.suggestions));
  });

  test('a one-character query is refused without touching the database', async () => {
    const result = await suggestRoute.handle({
      url: new URL('http://x/api/v1/suggest?q=s'),
      db: pool,
    });
    assert.deepEqual(result.body.suggestions, []);
  });
});

describe('the click loop, end to end', () => {
  test('a click updates its impression and the rollup corrects for position', async () => {
    const { run: rollup } = await import('../src/jobs/ctr-rollup.js');

    // Five impressions of the same query, all clicked, so the rollup's
    // HAVING count(*) >= 5 is satisfied. The query has to be one that actually
    // matches the seeded content -- a query with no results logs no impressions,
    // and there is then nothing for the rollup to aggregate.
    let clicks = 0;
    for (let i = 0; i < 5; i++) {
      const result = await search({ q: 'shabbat rest kept' });
      const first = result.zone_a.results[0];
      assert.ok(first, 'the probe query returned nothing to click');
      clicks++;
      await pool.query(
        `UPDATE result_impressions SET clicked = TRUE, clicked_at = now()
          WHERE query_id = $1 AND page_id = $2 AND zone = 'A' AND position = 1`,
        [result.query_id, first.page_id]);
    }

    assert.equal(clicks, 5);

    const { rows_rolled_up } = await rollup(pool);
    assert.ok(rows_rolled_up > 0, 'the rollup produced nothing to rank with');

    const { rows } = await pool.query(
      'SELECT raw_ctr, corrected_ctr, confidence FROM query_page_ctr LIMIT 1');
    assert.ok(rows[0], 'no CTR row');
    assert.ok(Number(rows[0].corrected_ctr) >= 0 && Number(rows[0].corrected_ctr) <= 1);
    // Confidence shrinks toward zero on low volume: five impressions out of the
    // fifty the rollup treats as full trust.
    assert.ok(Number(rows[0].confidence) < 1);
  });
});

describe('near-duplicate detection, executed', () => {
  test('simhash_distance agrees with the JavaScript implementation', async () => {
    const { simhash, hammingDistance, toSigned } = await import('../src/crawl/simhash.js');
    const a = simhash('the appointed times are a shadow of what is to come');
    const b = simhash('the appointed times are a shadow of what is to come, and the body is of messiah');

    const { rows } = await pool.query('SELECT simhash_distance($1, $2) AS d',
      [toSigned(a).toString(), toSigned(b).toString()]);
    assert.equal(Number(rows[0].d), hammingDistance(a, b),
      'the SQL and JS Hamming distances disagree, so clustering would be inconsistent');
  });
});

describe('trust-graph discovery (§10.2)', () => {
  before(async () => {
    // Three more trusted domains to link from, so "three distinct T1/T2
    // domains" is reachable.
    await pool.query(
      `INSERT INTO domains (host, tier, status) VALUES
         ('trusted-a.example', 'T1', 'active'),
         ('trusted-b.example', 'T2', 'active'),
         ('trusted-c.example', 'T2', 'active')
       ON CONFLICT (host) DO UPDATE SET status = 'active'`);

    for (const host of ['trusted-a.example', 'trusted-b.example', 'trusted-c.example']) {
      await pool.query(
        `INSERT INTO pages (domain_id, url, url_hash, status, tier, title, body_text)
         SELECT id, $2, sha256(convert_to($2,'UTF8')), 'indexed', tier, 'hub', 'words here to be a page'
           FROM domains WHERE host = $1
         ON CONFLICT (domain_id, url_hash) DO NOTHING`,
        [host, `https://${host}/links`]);
    }

    const link = async (fromHost, toHost, rel = null) => {
      await pool.query(
        `INSERT INTO links (from_page_id, to_url_hash, to_url, to_host, is_internal, rel)
         SELECT p.id, sha256(convert_to($2,'UTF8')), $2, $3, FALSE, $4
           FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.host = $1
          LIMIT 1
         ON CONFLICT (from_page_id, to_url_hash) DO NOTHING`,
        [fromHost, `https://${toHost}/`, toHost, rel]);
    };

    // Three independent vouches -> nominated.
    await link('trusted-a.example', 'candidate.example');
    await link('trusted-b.example', 'candidate.example');
    await link('trusted-c.example', 'candidate.example');

    // Two vouches only -> below the threshold.
    await link('trusted-a.example', 'thin.example');
    await link('trusted-b.example', 'thin.example');

    // Three vouches, all nofollow -> the linking sites declined to vouch.
    await link('trusted-a.example', 'nofollow.example', 'nofollow');
    await link('trusted-b.example', 'nofollow.example', 'nofollow');
    await link('trusted-c.example', 'nofollow.example', 'nofollow');
  });

  test('nominates a host that three trusted domains link to', async () => {
    const { nominateFromTrustGraph } = await import('../src/crawl/discovery.js');
    const { ranking } = await import('../src/config.js');
    const result = await nominateFromTrustGraph(pool, await ranking());
    assert.ok(result.nominated > 0, 'nothing was nominated');

    const { rows } = await pool.query(
      "SELECT * FROM domain_candidates WHERE host = 'candidate.example'");
    assert.ok(rows[0], 'candidate.example was not nominated');
    assert.equal(Number(rows[0].linking_domains), 3);
    assert.equal(rows[0].target_tier, 'T3');
    assert.equal(rows[0].source, 'trust_graph');
    assert.equal(rows[0].linking_hosts.length, 3, 'the evidence must name who linked');
  });

  test('two vouches is not enough', async () => {
    const { rows } = await pool.query(
      "SELECT 1 FROM domain_candidates WHERE host = 'thin.example'");
    assert.equal(rows.length, 0, 'nominated below the threshold');
  });

  test('nofollow links do not count as a vouch', async () => {
    const { rows } = await pool.query(
      "SELECT 1 FROM domain_candidates WHERE host = 'nofollow.example'");
    assert.equal(rows.length, 0,
      'rel=nofollow is the linking site declining to vouch, and must not nominate');
  });

  test('an already-registered host is never nominated', async () => {
    const { rows } = await pool.query(
      'SELECT c.host FROM domain_candidates c JOIN domains d ON d.host = c.host');
    assert.deepEqual(rows, [], 'a host already in the registry appeared in the queue');
  });

  test('re-running refreshes evidence rather than duplicating', async () => {
    const { nominateFromTrustGraph } = await import('../src/crawl/discovery.js');
    const { ranking } = await import('../src/config.js');
    const again = await nominateFromTrustGraph(pool, await ranking());
    assert.equal(again.nominated, 0);
    assert.ok(again.refreshed > 0);

    const { rows } = await pool.query(
      "SELECT count(*) AS n FROM domain_candidates WHERE host = 'candidate.example'");
    assert.equal(Number(rows[0].n), 1);
  });

  test('gate 1 screens a candidate before anything is fetched', async () => {
    const { screenCandidates } = await import('../src/crawl/discovery.js');
    const result = await screenCandidates(pool);
    assert.ok(result.screened > 0);

    const { rows } = await pool.query(
      "SELECT status, screening_verdict FROM domain_candidates WHERE host = 'candidate.example'");
    assert.equal(rows[0].status, 'screening');
    assert.equal(rows[0].screening_verdict, 'clear');
  });

  test('a blocklisted host is rejected at gate 1 and never reaches the registry', async () => {
    await pool.query(
      `INSERT INTO blocklist_entries (pattern, match_type, category, source, severity)
       VALUES ('bad.example', 'host', 'adult', 'manual', 100)`);
    await pool.query(
      `INSERT INTO domain_candidates (host, target_tier, source, linking_domains)
       VALUES ('bad.example', 'T3', 'trust_graph', 5)
       ON CONFLICT (host) DO UPDATE SET status = 'nominated'`);

    const { screenCandidates } = await import('../src/crawl/discovery.js');
    await screenCandidates(pool);

    const { rows } = await pool.query(
      "SELECT status FROM domain_candidates WHERE host = 'bad.example'");
    assert.equal(rows[0].status, 'rejected');

    const { rows: registered } = await pool.query(
      "SELECT 1 FROM domains WHERE host = 'bad.example'");
    assert.equal(registered.length, 0, 'a rejected candidate must never reach the registry');
  });

  test('a probe enters at T0, and T0 is never servable', async () => {
    const { beginProbe } = await import('../src/crawl/discovery.js');
    const { ranking } = await import('../src/config.js');
    const cfg = await ranking();

    const { rows: candidate } = await pool.query(
      "SELECT id FROM domain_candidates WHERE host = 'candidate.example'");
    const probe = await beginProbe(pool, candidate[0].id, cfg, 'test');
    assert.equal(probe.started, true);
    assert.equal(probe.probe_pages, cfg.discovery_probe_pages);

    const { rows } = await pool.query(
      "SELECT tier, max_pages FROM domains WHERE host = 'candidate.example'");
    assert.equal(rows[0].tier, 'T0', 'a probe must start in quarantine');
    assert.equal(Number(rows[0].max_pages), cfg.discovery_probe_pages);

    // §10.2: nothing from a candidate is served while it sits in T0.
    const { rows: servable } = await pool.query(
      `SELECT count(*) AS n FROM servable_pages p
         JOIN domains d ON d.id = p.domain_id WHERE d.host = 'candidate.example'`);
    assert.equal(Number(servable[0].n), 0);
  });
});

describe('blocklist admin guard', () => {
  const entryRoute = async () => {
    const { routes } = await import('../src/api/routes/admin.js');
    return routes.find((r) => r.method === 'POST' && r.match('/api/v1/admin/blocklists/entries'));
  };

  test('a single-word keyword cannot be a hard block', async () => {
    // The scripture problem, enforced at the API rather than only documented in
    // a migration comment nobody reads before adding a rule.
    const route = await entryRoute();
    await assert.rejects(
      () => route.handle({
        db: pool,
        identity: { jubilee_id: 'test' },
        body: { parsed: { pattern: 'adultery', match_type: 'keyword', category: 'adult', severity: 100 } },
      }),
      /single-word keyword cannot be a hard block/);
  });

  test('the same word at a reviewable severity is allowed', async () => {
    const route = await entryRoute();
    const result = await route.handle({
      db: pool,
      identity: { jubilee_id: 'test' },
      body: { parsed: { pattern: 'adultery', match_type: 'keyword', category: 'adult', severity: 40 } },
    });
    assert.equal(result.status, 201);
    assert.equal(Number(result.body.severity), 40);
  });

  test('only manual entries can be deleted', async () => {
    const { routes } = await import('../src/api/routes/admin.js');
    const route = routes.find((r) => r.method === 'DELETE');
    const { rows } = await pool.query(
      "INSERT INTO blocklist_entries (pattern, match_type, category, source, severity) " +
      "VALUES ('loaded.example', 'host', 'adult', 'stevenblack:adult', 100) RETURNING id");

    await assert.rejects(
      () => route.handle({ db: pool, params: { id: rows[0].id }, identity: { jubilee_id: 'test' } }),
      /no such manual entry/);
  });
});

describe('retention (§17 privacy)', () => {
  before(async () => {
    const { rows: domain } = await pool.query(
      "SELECT id FROM domains WHERE host = 'jubileeverse.com'");
    const { rows: page } = await pool.query(
      "SELECT id FROM pages WHERE tier = 'T1' LIMIT 1");

    // Three query logs: one old and identified, one old and already anonymous,
    // one recent and identified.
    // A distinct label per row: two of these are the same age, and a shared
    // query_text would make the lookups below match both.
    const add = async (label, age, jubileeId, sessionId) => {
      const { rows } = await pool.query(
        `INSERT INTO search_queries
            (query_text, normalized, intent, lang, jubilee_id, session_id, created_at)
         VALUES ($1, $1, 'topical', 'en', $2, $3, now() - ($4 || ' days')::interval)
         RETURNING id`,
        [label, jubileeId, sessionId, String(age)]);
      return Number(rows[0].id);
    };

    const oldIdentified = await add('probe old identified', 400, 'jubilee|old', 'sess-old');
    await add('probe old anonymous', 400, null, null);
    await add('probe recent', 10, 'jubilee|recent', 'sess-recent');

    // An impression on the old row, to prove anonymising keeps aggregate
    // click learning intact rather than cascading it away.
    await pool.query(
      `INSERT INTO result_impressions (query_id, page_id, zone, position, clicked)
       VALUES ($1, $2, 'A', 1, TRUE)`, [oldIdentified, page[0].id]);

    await pool.query(
      `INSERT INTO abuse_reports (page_id, url, reason, reporter_ip, created_at)
       VALUES ($1, 'https://x.example/old', 'probe', '198.51.100.7'::inet,
               now() - interval '400 days')`, [page[0].id]);
    await pool.query(
      `INSERT INTO abuse_reports (page_id, url, reason, reporter_ip, created_at)
       VALUES ($1, 'https://x.example/new', 'probe', '198.51.100.8'::inet, now())`,
      [page[0].id]);

    await pool.query(
      `INSERT INTO crawl_failures (domain_id, url, reason, outcome, at)
       VALUES ($1, 'https://x.example/f', 'probe', 'error', now() - interval '200 days')`,
      [domain[0].id]);

    void domain;
  });

  test('a dry run reports what it would do and changes nothing', async () => {
    const { run } = await import('../src/jobs/retention.js');
    const planned = await run(pool, { dryRun: true });

    assert.equal(planned.dry_run, true);
    assert.ok(planned.would_anonymise >= 1, 'the 400-day-old identified query was not counted');
    assert.ok(planned.would_drop_ips >= 1);

    const { rows } = await pool.query(
      "SELECT jubilee_id FROM search_queries WHERE query_text = 'probe old identified' AND jubilee_id IS NOT NULL");
    assert.equal(rows.length, 1, 'a dry run modified data');
  });

  test('strips the identifiers from a query older than the window', async () => {
    const { run } = await import('../src/jobs/retention.js');
    const result = await run(pool);
    assert.ok(result.queries_anonymised >= 1);

    const { rows } = await pool.query(
      "SELECT jubilee_id, session_id, query_text FROM search_queries WHERE query_text = 'probe old identified'");
    assert.equal(rows.length, 1, 'the row was deleted; it should have been anonymised');
    assert.equal(rows[0].jubilee_id, null);
    assert.equal(rows[0].session_id, null);
    // The query itself survives. It is what makes aggregate learning possible
    // and, with no identifier attached, is no longer about anybody.
    assert.equal(rows[0].query_text, 'probe old identified');
  });

  test('leaves a recent query alone', async () => {
    const { rows } = await pool.query(
      "SELECT jubilee_id FROM search_queries WHERE query_text = 'probe recent'");
    assert.equal(rows[0].jubilee_id, 'jubilee|recent');
  });

  test('aggregate click learning survives anonymisation', async () => {
    // §17 permits purging *or* anonymising, and this is why it is the latter:
    // deleting the row would cascade the impression away with it.
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM result_impressions ri
         JOIN search_queries sq ON sq.id = ri.query_id
        WHERE sq.query_text = 'probe old identified' AND ri.clicked`);
    assert.equal(Number(rows[0].n), 1, 'the click was lost with the identifier');
  });

  test('drops an old reporter IP and keeps the report', async () => {
    const { rows } = await pool.query(
      "SELECT reporter_ip, reason FROM abuse_reports WHERE url = 'https://x.example/old'");
    assert.equal(rows.length, 1, 'the report itself was deleted; it is a record of a decision');
    assert.equal(rows[0].reporter_ip, null);
  });

  test('keeps a recent reporter IP, which is still needed to investigate', async () => {
    const { rows } = await pool.query(
      "SELECT reporter_ip FROM abuse_reports WHERE url = 'https://x.example/new'");
    assert.ok(rows[0].reporter_ip, 'a current report lost the address it may need');
  });

  test('deletes stale operational logs', async () => {
    const { rows } = await pool.query(
      "SELECT count(*) AS n FROM crawl_failures WHERE url = 'https://x.example/f'");
    assert.equal(Number(rows[0].n), 0);
  });

  test('records the pass, so the claim is auditable', async () => {
    const { rows } = await pool.query(
      'SELECT queries_anonymised, ran_at FROM retention_runs ORDER BY id DESC LIMIT 1');
    assert.ok(rows[0], 'no retention_runs row was written');
    assert.ok(Number(rows[0].queries_anonymised) >= 1);
  });

  test('the audit agrees the privacy notice is accurate once it has run', async () => {
    const { audit } = await import('../src/jobs/retention.js');
    const result = await audit(pool);
    assert.equal(result.overdue_records, 0);
    assert.equal(result.notice_is_accurate, true,
      'the notice promises a retention window the database does not honour');
  });

  test('a second pass is a no-op', async () => {
    const { run } = await import('../src/jobs/retention.js');
    const again = await run(pool);
    assert.equal(again.queries_anonymised, 0);
    assert.equal(again.ips_dropped, 0);
  });
});


describe('content requests (§13.5 empty state)', () => {
  // Zone A's empty state invites the reader to say what they wanted. The link
  // 404'd for the whole life of the page before this; these pin the table it
  // now writes to, and the promise the page makes about it.

  test('a request is stored with the query it came from', async () => {
    await pool.query(
      `INSERT INTO content_requests (query_text, note, lang)
       VALUES ($1, $2, $3)`,
      ['tell me about bible', 'Somewhere to start reading as an adult convert.', 'en']);

    const { rows } = await pool.query(
      `SELECT query_text, note, lang FROM content_requests
        WHERE query_text = 'tell me about bible'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'Somewhere to start reading as an adult convert.');
    assert.equal(rows[0].lang, 'en');
  });

  test('the note is optional -- a bare query is still a signal', async () => {
    await pool.query(
      'INSERT INTO content_requests (query_text, lang) VALUES ($1, $2)',
      ['fasting for beginners', 'en']);
    const { rows } = await pool.query(
      `SELECT note FROM content_requests WHERE query_text = 'fasting for beginners'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, null);
  });

  test('the table holds no identifier of any kind', async () => {
    // The privacy notice and the page both promise this outright: a request
    // cannot be traced to a person. The cheapest way for that to become false
    // later is for someone to add a column, so assert on the shape itself.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'content_requests'`);
    const columns = rows.map((r) => r.column_name).sort();
    assert.deepEqual(columns, ['created_at', 'id', 'lang', 'note', 'query_text'],
      'content_requests gained a column; if it identifies a reader, the privacy notice is now false');
  });
});


// ---------------------------------------------------------------------------
// Ranking config drift.
//
// A fresh deployment once seeded zone_a_relevance_floor = 0.0150 while migration
// 026's own comment asserted the tuned value was 0.0080. Nothing errored and no
// test failed: the value had been changed through /api/v1/admin/ranking, which
// writes to ONE database and leaves the migrations untouched. It surfaced only
// from replaying the migrations onto a clean database by hand.
//
// That will recur — tuning through the console is the point of the console — so
// this makes the comparison visible on every run rather than something someone
// has to think to check.
//
// It PRINTS rather than fails on divergence between a database and the seeds:
// a dev database being tuned is legitimate. What it does assert is the one thing
// that is always a bug — a migration whose prose names a value its SQL does not
// set, which is exactly what shipped.
// ---------------------------------------------------------------------------
describe('ranking config drift', () => {
  const ZONE_A = [
    'zone_a_relevance_floor',
    'zone_a_moderate_threshold',
    'zone_a_strong_threshold',
    'zone_a_cross_encoder_floor',
  ];

  /** Replay the migration files to find the last value each key is given. */
  async function seededValues() {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const seeded = new Map();
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      // Strip comments first, or a value quoted in prose is read as if it were set.
      const code = sql.replace(/--[^\n]*/g, '');

      // Per STATEMENT, not per file. A lazy match across a whole file will
      // happily pair one UPDATE's value with a later statement's key: the first
      // version of this reported drift on two keys that had none, which is worse
      // than no test at all — it trains everyone to ignore the output.
      for (const stmt of code.split(';')) {
        for (const key of ZONE_A) {
          const hasKey = new RegExp(`key\\s*=\\s*'${key}'`).test(stmt);
          const upd = stmt.match(/UPDATE\s+ranking_config\s+SET\s+value\s*=\s*(-?[0-9.]+)/);
          if (upd && hasKey) seeded.set(key, { value: Number(upd[1]), file });

          const ins = stmt.match(new RegExp(`\\('${key}',\\s*(-?[0-9.]+)`));
          if (ins) seeded.set(key, { value: Number(ins[1]), file });
        }
      }
    }
    return seeded;
  }

  test('live values match what the migrations seed (prints, does not fail)', async () => {
    const seeded = await seededValues();
    const { rows } = await pool.query(
      `SELECT key, value FROM ranking_config WHERE key = ANY($1)`, [ZONE_A],
    );
    const live = new Map(rows.map((r) => [r.key, Number(r.value)]));

    const lines = [];
    let drifted = 0;
    for (const key of ZONE_A) {
      const s = seeded.get(key);
      const l = live.get(key);
      if (s === undefined || l === undefined) {
        lines.push(`    ${key.padEnd(28)} seeded=${s ? s.value : 'MISSING'}  live=${l ?? 'MISSING'}`);
        continue;
      }
      const same = Math.abs(s.value - l) < 1e-9;
      if (!same) drifted += 1;
      lines.push(`    ${key.padEnd(28)} seeded=${String(s.value).padEnd(8)} live=${String(l).padEnd(8)} ${same ? 'ok' : '<-- DRIFT'}  (${s.file})`);
    }

    console.log('\n  ranking config, migrations vs this database:');
    for (const line of lines) console.log(line);
    if (drifted) {
      console.log(`  ${drifted} key(s) differ. Legitimate in a tuned database — but a value that`);
      console.log('  should survive a deployment needs a migration, not a console change.');
    }

    // Every key must exist. A missing one means a rename that left readers of
    // ranking_config looking for something that is not there.
    for (const key of ZONE_A) {
      assert.ok(live.has(key), `${key} is absent from ranking_config`);
      assert.ok(seeded.has(key), `${key} is never set by any migration`);
    }
  });

  test('a migration never names a value in prose that its SQL does not set', async () => {
    // The shipped bug: 026's comment said 0.0080, and on a fresh database the
    // value was 0.0150, because only a later migration set it.
    const seeded = await seededValues();
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      for (const key of ZONE_A) {
        // "zone_a_relevance_floor = 0.0080" or "zone_a_relevance_floor is set to 0.0080"
        for (const m of sql.matchAll(
          new RegExp(key + "\\s*(?:=|is set to)\\s*`?(-?[0-9.]+)`?", 'g'),
        )) {
          const claimed = Number(m[1]);
          const actual = seeded.get(key)?.value;
          assert.ok(actual !== undefined, `${file} names ${key} but no migration sets it`);
          assert.ok(Math.abs(claimed - actual) < 1e-9,
            `${file} says ${key} = ${claimed}, but the migrations leave it at ${actual} `
            + `(set in ${seeded.get(key).file}). Documentation and configuration disagree.`);
        }
      }
    }
  });
});