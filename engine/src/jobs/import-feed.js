// Content feed importer.
//
//   node src/jobs/import-feed.js --domain=jubileeverse.com
//   node src/jobs/import-feed.js --domain=jubileeverse.com --full
//   node src/jobs/import-feed.js --domain=jubileeverse.com --dry-run
//
// Replaces crawling for a domain whose `ingest_mode` is 'feed'. The publisher
// exposes a paged, incremental list of everything it wants searchable, and this
// walks it. See src/ingest/feed.js for why a crawler cannot do this job on the
// Jubilee sites.
//
// Incremental by default. `ingest_runs` records the high-water mark of the last
// successful run, and the next one asks the publisher for records newer than
// that. `--full` ignores it, which is what to reach for after a schema change
// or when a publisher has back-filled old rows without touching `updated_at`.
//
// The three properties §12 asks for are not implemented here, because
// `upsertPage` already has them and duplicating them would give two answers:
//
//   * a record whose content hash is unchanged is skipped without re-chunking,
//   * a record that did change has its old chunks DELETED and rewritten, so no
//     stale embedding can survive an edit,
//   * new chunks land with embedded_at NULL, which is the embedding job's queue.

import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from '../db.js';
import { upsertPage, markGone } from '../ingest/service.js';
import { mapFeedItem, feedMarkdown, feedUrl } from '../ingest/feed.js';

const TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS ?? 30_000);
const PAGE_SIZE = Number(process.env.FEED_PAGE_SIZE ?? 100);
// A publisher that keeps handing back a cursor is a bug, not a large corpus.
const MAX_PAGES = Number(process.env.FEED_MAX_PAGES ?? 500);

async function loadDomain(db, host) {
  const { rows } = await db.query(
    `SELECT id, host, tier, status, ingest_mode, source_root, language_hint,
            zone_a_eligible
       FROM domains WHERE host = $1`, [host]);
  return rows[0] ?? null;
}

/** The newest `updated_at` this domain has successfully imported. */
async function lastSync(db, domainId) {
  const { rows } = await db.query(
    `SELECT high_water_mark FROM ingest_runs
      WHERE domain_id = $1 AND mode = 'feed' AND error IS NULL
        AND high_water_mark IS NOT NULL
      ORDER BY high_water_mark DESC LIMIT 1`, [domainId]);
  return rows[0]?.high_water_mark ?? null;
}

// The service token the feed requires. A feed is an internal, server-to-server
// content export and the publisher's endpoint refuses without it -- see
// docs/SEARCH-FEED.md and jubileeverse.com/server/routes/search-feed.js, which
// fails closed rather than serving openly when its own copy is unset.
//
// Read from the environment, never stored in the database: `domains` is readable
// through the admin API, and a credential that can be read back out of an admin
// GET is a credential in somebody's browser history. The same reasoning keeps
// `webhook_secret` out of every admin read.
const FEED_TOKEN = process.env.SEARCH_FEED_TOKEN || '';

// Cloudflare Access sits in front of the Jubilee services (see
// CLOUDFLARE_SERVICE_TOKEN_GUIDE.md in the jubileeverse and kJubilee repos), and
// a request that has to traverse it needs the service-token pair as well. Both
// optional: unset means the feed is reached directly.
const CF_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';

async function fetchPage(url) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'JubileeSearchImporter/1.0',
  };
  if (FEED_TOKEN) headers.authorization = `Bearer ${FEED_TOKEN}`;
  if (CF_CLIENT_ID) headers['CF-Access-Client-Id'] = CF_CLIENT_ID;
  if (CF_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = CF_CLIENT_SECRET;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

  if (res.status === 401 || res.status === 403) {
    // Named precisely, because the three causes need different fixes and all
    // three otherwise present as "the import does not work".
    throw new Error(FEED_TOKEN
      ? `the feed rejected our token (${res.status}). Check SEARCH_FEED_TOKEN matches the publisher's, `
        + 'and whether Cloudflare Access needs CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET too.'
      : `the feed requires authentication (${res.status}) and SEARCH_FEED_TOKEN is not set.`);
  }
  if (res.status === 503) {
    throw new Error('the feed answered 503. If the publisher has not set its own '
      + 'SEARCH_FEED_TOKEN the endpoint fails closed and serves nothing.');
  }
  if (!res.ok) throw new Error(`feed returned ${res.status} for ${url}`);

  const json = await res.json();
  if (!Array.isArray(json?.items)) throw new Error('feed response has no items array');
  return json;
}

export async function run({ host, full = false, dryRun = false, db = pool } = {}) {
  const domain = await loadDomain(db, host);
  if (!domain) throw new Error(`no domain registered for ${host}`);
  if (!domain.source_root) {
    throw new Error(`${host} has no source_root; set it to the feed URL, e.g. https://${host}/api/search-feed`);
  }
  // A feed is a claim by the publisher about its own site. Importing one into a
  // domain the network has not verified would put unverified content into Zone
  // A, which §8.2 reserves for verified T1.
  if (domain.status !== 'active') {
    throw new Error(`${host} is ${domain.status}; only an active domain can be imported`);
  }

  const since = full ? null : await lastSync(db, domain.id);
  const started = new Date();

  let cursor = null;
  let pages = 0;
  let seen = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let rejected = 0;
  let invalid = 0;
  let highWater = since ? new Date(since) : null;
  const seenIds = new Set();
  const problems = [];

  try {
    do {
      const url = feedUrl(domain.source_root, { since, cursor, limit: PAGE_SIZE });
      const page = await fetchPage(url);
      pages += 1;

      for (const item of page.items) {
        seen += 1;
        const { errors, mapped, feed_id: feedId } = mapFeedItem(item, domain);
        if (errors.length) {
          invalid += 1;
          if (problems.length < 20) problems.push({ id: item?.id ?? null, errors });
          continue;
        }
        seenIds.add(feedId);
        if (mapped.modified_at && (!highWater || mapped.modified_at > highWater)) {
          highWater = mapped.modified_at;
        }

        if (dryRun) continue;

        // priority 1: §12.2 puts publish-push chunks at the front of the
        // embedding queue to meet the 60-second freshness target. A feed import
        // IS a publish-push.
        const result = await upsertPage(domain, mapped, feedMarkdown(mapped), { priority: 1 });
        if (result.status === 'created') created += 1;
        else if (result.status === 'updated') updated += 1;
        else if (result.status === 'unchanged') unchanged += 1;
        else if (result.status === 'rejected') {
          rejected += 1;
          if (problems.length < 20) problems.push({ id: feedId, errors: [result.reason] });
        }
      }

      cursor = page.next_cursor ?? null;
      if (pages >= MAX_PAGES) {
        problems.push({ id: null, errors: [`stopped at ${MAX_PAGES} pages; the feed kept paging`] });
        break;
      }
    } while (cursor);

    // Deletions, on a full run only. A record absent from an INCREMENTAL page is
    // simply one that has not changed -- treating that as "withdrawn" would
    // empty the index on the first quiet sync.
    let withdrawn = 0;
    if (full && !dryRun) {
      const { rows } = await db.query(
        `SELECT url, source_path FROM pages
          WHERE domain_id = $1 AND source_path LIKE 'feed:%' AND status <> 'gone'`,
        [domain.id]);
      for (const row of rows) {
        if (!seenIds.has(row.source_path.slice(5))) {
          await markGone(domain.id, row.url);
          withdrawn += 1;
        }
      }
    }

    if (!dryRun) {
      await db.query(
        `INSERT INTO ingest_runs (domain_id, mode, started_at, finished_at,
                                  items_seen, items_written, high_water_mark)
         VALUES ($1, 'feed', $2, now(), $3, $4, $5)`,
        [domain.id, started, seen, created + updated, highWater]);
    }

    return {
      host, mode: full ? 'full' : 'incremental', dry_run: dryRun,
      since: since ? new Date(since).toISOString() : null,
      pages, seen, created, updated, unchanged, rejected, invalid, withdrawn,
      high_water_mark: highWater ? highWater.toISOString() : null,
      problems,
    };
  } catch (err) {
    if (!dryRun) {
      await db.query(
        `INSERT INTO ingest_runs (domain_id, mode, started_at, finished_at,
                                  items_seen, items_written, error)
         VALUES ($1, 'feed', $2, now(), $3, $4, $5)`,
        [domain.id, started, seen, created + updated, err.message]).catch(() => {});
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const has = (name) => process.argv.includes(`--${name}`);
  const host = arg('domain');

  if (!host) {
    console.error(`usage: node src/jobs/import-feed.js --domain=<host> [--full] [--dry-run]

The domain must be registered and active, with source_root set to its feed URL:

  npm run admin -- domains set jubileeverse.com --source-root=https://jubileeverse.com/api/search-feed
`);
    process.exit(2);
  }

  try {
    const result = await run({ host, full: has('full'), dryRun: has('dry-run') });
    console.log(JSON.stringify({ level: 'info', at: 'job.import-feed', ...result }));
    await pool.end();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'job.import-feed', msg: err.message }));
    await pool.end();
    process.exit(1);
  }
}

export { withTransaction };
