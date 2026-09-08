// Nightly T1 source ingest and reconciliation (R5, R6, §9.1, §9.2).
//
// §9.2 is emphatic that this exists whatever the webhook does: "The nightly run
// does not go away. It becomes a reconciliation pass that catches missed
// webhooks, detects deletions, and repairs drift. Webhooks are an optimization,
// never the sole source of truth." The risk register rates silent webhook
// failure as Medium/Medium with this as the mitigation, so it is not to be
// switched off once publish-push looks reliable.
//
// Acceptance criterion 1: "Every registered T1 domain is ingested from source
// markdown where available, and the run is logged with pages processed, changed,
// and failed." That log is the ingest_runs row this writes.

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { enumerateMarkdown, readSource } from '../ingest/source.js';
import { mapToPage } from '../ingest/markdown.js';
import { upsertPage } from '../ingest/service.js';

export async function ingestDomain(domain, db = pool) {
  const { rows: runRows } = await db.query(
    `INSERT INTO ingest_runs (domain_id, mode) VALUES ($1, 'source_md') RETURNING id`,
    [domain.id]);
  const runId = runRows[0].id;

  const counts = { seen: 0, changed: 0, failed: 0, rejected: 0, gone: 0 };
  const seenPaths = [];

  try {
    const paths = await enumerateMarkdown(domain.source_root);

    for (const path of paths) {
      counts.seen++;
      try {
        const markdown = await readSource(domain.source_root, path);
        if (markdown === null) { counts.failed++; continue; }

        const mapped = mapToPage(markdown, domain, path);
        const result = await upsertPage(domain, mapped, markdown);

        seenPaths.push(path);
        if (result.status === 'rejected') counts.rejected++;
        else if (result.status !== 'unchanged') counts.changed++;
      } catch (err) {
        counts.failed++;
        console.error(JSON.stringify({
          level: 'error', at: 'job.ingest', host: domain.host, path, msg: err.message }));
      }
    }

    // Deletion detection. A page whose source file has gone is marked `gone`,
    // which removes it from servable_pages immediately, and its chunks go with
    // it. Without this pass an unpublished article that missed its webhook stays
    // searchable indefinitely.
    //
    // Guarded on a non-empty enumeration: if the CDN answers with an empty
    // manifest for a minute, this would otherwise delete the entire domain from
    // the index and the next run would re-ingest it, with a gap in between.
    if (seenPaths.length > 0) {
      // rowCount on the DELETE would count chunks, not pages, so the number
      // reported as "gone" would be several times the number of articles that
      // actually went. The page count comes back explicitly.
      const { rows } = await db.query(
        `WITH vanished AS (
             UPDATE pages SET status = 'gone'
              WHERE domain_id = $1
                AND source_path IS NOT NULL
                AND NOT (source_path = ANY($2::text[]))
                AND status <> 'gone'
              RETURNING id),
              cleared AS (
             DELETE FROM chunks WHERE page_id IN (SELECT id FROM vanished))
         SELECT count(*) AS pages_gone FROM vanished`,
        [domain.id, seenPaths]);
      counts.gone = Number(rows[0].pages_gone);
    }

    await db.query(
      `UPDATE ingest_runs
          SET finished_at = now(), pages_seen = $2, pages_changed = $3, pages_failed = $4
        WHERE id = $1`,
      [runId, counts.seen, counts.changed, counts.failed]);

    await db.query(
      `UPDATE domains
          SET last_crawl_started = now(), last_crawl_finished = now(),
              next_crawl_due = now() + (crawl_interval_hours || ' hours')::interval,
              consecutive_failures = 0
        WHERE id = $1`, [domain.id]);

    return { host: domain.host, ...counts };
  } catch (err) {
    await db.query(
      `UPDATE ingest_runs SET finished_at = now(), error = $2, pages_seen = $3,
                              pages_changed = $4, pages_failed = $5
        WHERE id = $1`,
      [runId, err.message, counts.seen, counts.changed, counts.failed]);
    // §9.4: "Three consecutive hard failures pause the domain and raise an admin
    // alert." Applied here too -- a source root that has moved fails the same way
    // a host that stopped answering does.
    await db.query(
      `UPDATE domains
          SET consecutive_failures = consecutive_failures + 1,
              status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'paused'::domain_status
                            ELSE status END
        WHERE id = $1`, [domain.id]);
    return { host: domain.host, ...counts, error: err.message };
  }
}

export async function run(db = pool, { host = null } = {}) {
  const { rows } = await db.query(
    `SELECT id, host, tier, ingest_mode, source_root, url_template, language_hint
       FROM domains
      WHERE tier = 'T1'
        AND status IN ('active','pending')
        AND ingest_mode IN ('source_md','hybrid')
        AND source_root IS NOT NULL
        AND ($1::text IS NULL OR host = $1)
      ORDER BY host`, [host]);

  if (rows.length === 0) {
    // The most likely reason, stated as such, because it is decision D5 and it
    // is marked blocking on Phase 2. An empty run that says nothing here reads
    // like success.
    const { rows: counts } = await db.query(
      `SELECT count(*) FILTER (WHERE tier = 'T1') AS t1,
              count(*) FILTER (WHERE tier = 'T1' AND source_root IS NOT NULL) AS with_root
         FROM domains`);
    return {
      domains: 0,
      note: `${counts[0].with_root} of ${counts[0].t1} T1 domains have a source_root set. ` +
            'Source-first ingest cannot run without one (decision D5). ' +
            'Domains without a source_root fall back to ingest_mode = crawl, per section 9.1.',
    };
  }

  const results = [];
  for (const domain of rows) results.push(await ingestDomain(domain, db));

  const totals = results.reduce((acc, r) => ({
    seen: acc.seen + r.seen, changed: acc.changed + r.changed,
    failed: acc.failed + r.failed, rejected: acc.rejected + r.rejected,
    gone: acc.gone + r.gone,
  }), { seen: 0, changed: 0, failed: 0, rejected: 0, gone: 0 });

  return { domains: results.length, totals, results };
}

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hostArg = process.argv.find((a) => a.startsWith('--host='));
  const result = await run(pool, { host: hostArg?.split('=')[1] ?? null });
  console.log(JSON.stringify({ level: 'info', at: 'job.ingest', ...result }, null, 2));
  await pool.end();
}
