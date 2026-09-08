// Open-web discovery (§10).
//
// One pass of the candidate lifecycle: nominate from the trust graph, screen
// against gate 1, then promote or reject whatever has finished probing.
//
// Deliberately not part of the crawl worker. Discovery is a query over links the
// crawler already recorded, so it costs no requests and wants a different
// cadence — the graph does not change meaningfully between two crawls of the
// same site, and running this hourly would burn a large GROUP BY to learn
// nothing. Weekly, after the T2 recrawl, is the shape it is written for.
//
// Run:  npm run discover -- [--nominate-only] [--dry-run]

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { ranking } from '../config.js';
import {
  nominateFromTrustGraph, screenCandidates, promoteProbed, zeroResultGaps,
} from '../crawl/discovery.js';

export async function run(db = pool, { nominateOnly = false, dryRun = false } = {}) {
  const cfg = await ranking();

  if (dryRun) {
    // What the graph would nominate, without writing a candidate row. The
    // useful thing to look at before turning this loose on a real link graph
    // for the first time.
    const { rows } = await db.query(`
      WITH trusted_links AS (
          SELECT l.to_host, d.host AS from_host
            FROM links l
            JOIN pages p   ON p.id = l.from_page_id
            JOIN domains d ON d.id = p.domain_id
           WHERE NOT l.is_internal AND l.to_host IS NOT NULL
             AND d.tier IN ('T1','T2') AND d.status = 'active'
             AND COALESCE(l.rel, '') NOT LIKE '%nofollow%'
           GROUP BY l.to_host, d.host)
      SELECT to_host AS host, count(*) AS linking_domains,
             array_agg(from_host ORDER BY from_host) AS linking_hosts
        FROM trusted_links
       WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.host = to_host)
       GROUP BY to_host
       ORDER BY count(*) DESC
       LIMIT 50`);
    return {
      dry_run: true,
      threshold: cfg.discovery_min_linking_domains,
      would_nominate: rows.filter((r) => Number(r.linking_domains) >= cfg.discovery_min_linking_domains).length,
      top: rows.slice(0, 20),
    };
  }

  const nominated = await nominateFromTrustGraph(db, cfg);
  if (nominateOnly) return { nominated };

  const screened = await screenCandidates(db);
  const promoted = await promoteProbed(db, cfg);

  // §10.3 and §16: the gaps are a writing assignment before they are a crawl
  // target, so they are reported here rather than acted on.
  const gaps = await zeroResultGaps(db, { days: 30, minOccurrences: 3, limit: 20 });

  const { rows: queue } = await db.query(
    `SELECT target_tier, status, count(*) AS n
       FROM domain_candidates GROUP BY target_tier, status ORDER BY target_tier, status`);

  return {
    nominated,
    screened,
    promoted,
    queue,
    content_gaps: gaps.length,
    note: gaps.length
      ? `${gaps.length} zero-result queries seen 3+ times in 30 days. ` +
        'These are content assignments first (spec 16) and whitelist nominations second (spec 10.3).'
      : null,
  };
}

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(pool, {
    nominateOnly: process.argv.includes('--nominate-only'),
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify({ level: 'info', at: 'job.discover', ...result }, null, 2));
  await pool.end();
}
