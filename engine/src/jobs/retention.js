// Log retention (§17 Privacy).
//
// "Query logs ... are purged or anonymized after 13 months."
//
// This job is what makes the privacy notice true. Everything the notice says
// about how long things are kept is enforced here and nowhere else, so a change
// to either has to be a change to both.
//
// Nightly, after the CTR rollup. It is deliberately idempotent and cheap to
// re-run: a pass that finds nothing to do costs four indexed lookups.
//
// Run:  npm run retention -- [--dry-run]

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { ranking } from '../config.js';
import { sweepResultCache } from '../query/cache.js';

export async function run(db = pool, { dryRun = false } = {}) {
  const cfg = await ranking();

  const identifyDays = Math.round(cfg.retention_identify_days ?? 395);
  const ipDays = Math.round(cfg.retention_reporter_ip_days ?? 395);
  const failureDays = Math.round(cfg.retention_crawl_failure_days ?? 90);
  const nonceHours = Math.round(cfg.retention_webhook_nonce_hours ?? 1);

  // How old the oldest still-identified query is. Reported whether or not this
  // is a dry run: if it exceeds the window, the job has not been running, and
  // that is the number that says so.
  const { rows: oldest } = await db.query(
    `SELECT min(created_at) AS oldest FROM search_queries
      WHERE jubilee_id IS NOT NULL OR session_id IS NOT NULL`);

  if (dryRun) {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*) FROM search_queries
           WHERE created_at < now() - ($1 || ' days')::interval
             AND (jubilee_id IS NOT NULL OR session_id IS NOT NULL))     AS queries,
         (SELECT count(*) FROM abuse_reports
           WHERE created_at < now() - ($2 || ' days')::interval
             AND reporter_ip IS NOT NULL)                                AS ips,
         (SELECT count(*) FROM crawl_failures
           WHERE at < now() - ($3 || ' days')::interval)                 AS failures,
         (SELECT count(*) FROM webhook_nonces
           WHERE seen_at < now() - ($4 || ' hours')::interval)           AS nonces`,
      [String(identifyDays), String(ipDays), String(failureDays), String(nonceHours)]);

    return {
      dry_run: true,
      window_days: identifyDays,
      would_anonymise: Number(rows[0].queries),
      would_drop_ips: Number(rows[0].ips),
      would_delete_failures: Number(rows[0].failures),
      would_delete_nonces: Number(rows[0].nonces),
      oldest_identified: oldest[0].oldest,
    };
  }

  // --- the query log --------------------------------------------------------
  // The row survives; what ties it to a person does not. §17 permits purging or
  // anonymising, and anonymising is the reading that keeps the same paragraph's
  // "aggregate click learning" possible -- the impressions joined to this row
  // stay useful, while nothing remains to connect them to anybody.
  const { rowCount: queriesAnonymised } = await db.query(
    `UPDATE search_queries
        SET jubilee_id = NULL, session_id = NULL
      WHERE created_at < now() - ($1 || ' days')::interval
        AND (jubilee_id IS NOT NULL OR session_id IS NOT NULL)`,
    [String(identifyDays)]);

  // --- abuse reports --------------------------------------------------------
  // The IP exists to investigate one report. Once that is old, it is a stored
  // address with no purpose, which is the definition of data that should not
  // still be there. The report itself is kept: it is a record of a decision.
  const { rowCount: ipsDropped } = await db.query(
    `UPDATE abuse_reports SET reporter_ip = NULL
      WHERE created_at < now() - ($1 || ' days')::interval
        AND reporter_ip IS NOT NULL`,
    [String(ipDays)]);

  // --- operational logs -----------------------------------------------------
  const { rowCount: failuresDeleted } = await db.query(
    `DELETE FROM crawl_failures WHERE at < now() - ($1 || ' days')::interval`,
    [String(failureDays)]);

  const { rowCount: noncesDeleted } = await db.query(
    `DELETE FROM webhook_nonces WHERE seen_at < now() - ($1 || ' hours')::interval`,
    [String(nonceHours)]);

  // Expired cache rows hold a full result payload, including the query that
  // produced it. They are swept on this pass rather than only on the admin
  // button, because a disposable cache that never expires is not disposable.
  const cacheSwept = await sweepResultCache(db).catch(() => 0);

  await db.query(
    `INSERT INTO retention_runs
        (queries_anonymised, ips_dropped, failures_deleted, nonces_deleted,
         cache_swept, oldest_identified)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [queriesAnonymised, ipsDropped, failuresDeleted, noncesDeleted, cacheSwept,
     oldest[0].oldest]);

  return {
    window_days: identifyDays,
    queries_anonymised: queriesAnonymised,
    ips_dropped: ipsDropped,
    failures_deleted: failuresDeleted,
    nonces_deleted: noncesDeleted,
    cache_swept: cacheSwept,
  };
}

/**
 * What the privacy notice claims, checked against the database.
 *
 * Acceptance-style: it answers "is the thing we tell readers actually true?"
 * rather than "did the job run without error".
 */
export async function audit(db = pool) {
  const cfg = await ranking();
  const identifyDays = Math.round(cfg.retention_identify_days ?? 395);

  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM search_queries
         WHERE created_at < now() - ($1 || ' days')::interval
           AND (jubilee_id IS NOT NULL OR session_id IS NOT NULL))  AS overdue_queries,
       (SELECT count(*) FROM abuse_reports
         WHERE created_at < now() - ($1 || ' days')::interval
           AND reporter_ip IS NOT NULL)                             AS overdue_ips,
       (SELECT max(ran_at) FROM retention_runs)                     AS last_run`,
    [String(identifyDays)]);

  const overdue = Number(rows[0].overdue_queries) + Number(rows[0].overdue_ips);
  return {
    window_days: identifyDays,
    overdue_records: overdue,
    last_run: rows[0].last_run,
    notice_is_accurate: overdue === 0,
    note: overdue === 0
      ? null
      : `${overdue} record(s) are past the retention window the privacy notice states. `
        + 'Either the job is not scheduled, or it is failing.',
  };
}

// Run directly, not imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const result = await run(pool, { dryRun });
  console.log(JSON.stringify({ level: 'info', at: 'job.retention', ...result }, null, 2));
  if (!dryRun) {
    console.log(JSON.stringify({ level: 'info', at: 'job.retention.audit', ...(await audit(pool)) }, null, 2));
  }
  await pool.end();
}
