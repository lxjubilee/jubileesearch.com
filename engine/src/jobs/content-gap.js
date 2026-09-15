// The weekly content-gap report (§16, JubileeVerse row; §10.3).
//
//   node src/jobs/content-gap.js               # write this week's report
//   node src/jobs/content-gap.js --days=30     # window
//   node src/jobs/content-gap.js --stdout      # print, do not write
//
// "Zero-result queries, Zone A empty-state queries, and low-CTR queries are
// exported weekly as a content-gap report. If people search for something the
// network does not answer, that is a writing assignment."
//
// Three lists, each a different kind of gap:
//
//   zero_result   nothing at all came back -- the network has no page and
//                 the wider web is not admitted either. Pure demand.
//   zone_a_empty  the wider web answered but the network did not. The reader
//                 left Jubilee for it. The sharpest assignment of the three.
//   low_ctr       Zone A showed pages and readers did not click them. Either
//                 the pages are wrong or the titles are; a writing question
//                 either way.
//
// Everything is aggregate on `normalized`; no query is tied to a person (§17).
// The report is written as JSON (for tooling) and CSV (for the writing team),
// date-stamped, plus a `latest` copy, under REPORTS_DIR. The admin API serves
// the same builder live (routes/admin-ops.js), so the console and the file
// never disagree.

import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from '../db.js';
import { send as sendMail } from '../mail.js';

const REPORTS_DIR = process.env.REPORTS_DIR || 'reports';
// Where the report goes (§16 "exported weekly"): a comma-separated list of
// editors. Empty means the files under REPORTS_DIR and the console screen are
// the delivery, which is where it stood until 2026-09-15.
const RECIPIENTS = (process.env.CONTENT_GAP_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** @returns {Promise<object>} the report, ready to serialise */
export async function buildContentGapReport(db, { days = 7, minTimes = 2, minImpressions = 20, limit = 100 } = {}) {
  const since = [String(days)];
  const [zero, empty, lowCtr, totals] = await Promise.all([
    db.query(
      `SELECT normalized AS query, lang, intent, count(*) AS times, max(created_at) AS last_seen
         FROM search_queries
        WHERE created_at > now() - ($1 || ' days')::interval
          AND normalized <> ''
          AND COALESCE(zone_a_count, 0) + COALESCE(zone_b_count, 0) = 0
        GROUP BY 1, 2, 3
       HAVING count(*) >= $2
        ORDER BY count(*) DESC, max(created_at) DESC
        LIMIT $3`, [...since, minTimes, limit]),
    db.query(
      `SELECT normalized AS query, lang, intent, count(*) AS times, max(created_at) AS last_seen
         FROM search_queries
        WHERE created_at > now() - ($1 || ' days')::interval
          AND normalized <> ''
          AND COALESCE(zone_a_count, 0) = 0 AND COALESCE(zone_b_count, 0) > 0
        GROUP BY 1, 2, 3
       HAVING count(*) >= $2
        ORDER BY count(*) DESC, max(created_at) DESC
        LIMIT $3`, [...since, minTimes, limit]),
    db.query(
      `SELECT sq.normalized AS query,
              count(*) AS impressions,
              count(*) FILTER (WHERE ri.clicked) AS clicks,
              round(count(*) FILTER (WHERE ri.clicked)::numeric / NULLIF(count(*), 0), 4) AS ctr
         FROM result_impressions ri
         JOIN search_queries sq ON sq.id = ri.query_id
        WHERE ri.zone = 'A'
          AND sq.created_at > now() - ($1 || ' days')::interval
          AND sq.normalized <> ''
        GROUP BY 1
       HAVING count(*) >= $2
          AND count(*) FILTER (WHERE ri.clicked)::numeric / NULLIF(count(*), 0) < 0.05
        ORDER BY count(*) DESC
        LIMIT $3`, [...since, minImpressions, limit]),
    db.query(
      `SELECT count(*) AS searches,
              count(*) FILTER (WHERE COALESCE(zone_a_count,0) + COALESCE(zone_b_count,0) = 0) AS zero_result,
              count(*) FILTER (WHERE COALESCE(zone_a_count,0) = 0 AND COALESCE(zone_b_count,0) > 0) AS zone_a_empty
         FROM search_queries
        WHERE created_at > now() - ($1 || ' days')::interval AND normalized <> ''`, since),
  ]);
  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    thresholds: { min_times: minTimes, min_impressions: minImpressions, low_ctr_below: 0.05 },
    totals: totals.rows[0],
    zero_result: zero.rows,
    zone_a_empty: empty.rows,
    low_ctr: lowCtr.rows,
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One CSV with a `kind` column, so the writing team opens one file. */
export function reportToCsv(report) {
  const rows = [['kind', 'query', 'lang', 'intent', 'times', 'impressions', 'clicks', 'ctr', 'last_seen']];
  for (const r of report.zero_result) rows.push(['zero_result', r.query, r.lang, r.intent, r.times, '', '', '', r.last_seen]);
  for (const r of report.zone_a_empty) rows.push(['zone_a_empty', r.query, r.lang, r.intent, r.times, '', '', '', r.last_seen]);
  for (const r of report.low_ctr) rows.push(['low_ctr', r.query, '', '', '', r.impressions, r.clicks, r.ctr, '']);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** The e-mail body: the top of each list, readable without opening the CSV. */
export function reportToText(report, { top = 10 } = {}) {
  const n = (xs) => xs.length;
  const line = (r) => `  ${r.query}${r.lang ? ` (${r.lang})` : ''}` + (r.times ? `  x${r.times}` : '') + (r.ctr !== undefined ? `  ${r.impressions} shown, ${r.clicks} clicks` : '');
  const section = (title, xs, why) => [
    `${title} (${n(xs)})`, `  ${why}`, ...(xs.length ? xs.slice(0, top).map(line) : ['  none']),
    xs.length > top ? `  ... ${xs.length - top} more in the CSV` : '', ''];
  return [
    `Content-gap report, ${report.window_days} days to ${report.generated_at.slice(0, 10)}.`,
    `${report.totals.queries} searches; a writing assignment is anything below that recurs.`, '',
    ...section('Nothing came back', report.zero_result, 'no page in the network and the wider web not admitted: pure demand'),
    ...section('The wider web answered, Jubilee did not', report.zone_a_empty, 'the reader left the network for it'),
    ...section('Shown and not clicked', report.low_ctr, 'Zone A had pages and readers passed: wrong pages or wrong titles'),
    'The full lists are attached as CSV and on the console under Search analytics.',
  ].join('\n');
}

/**
 * Send the report to CONTENT_GAP_RECIPIENTS with the CSV attached. No
 * recipients, no send; a failed send is logged and does not fail the job --
 * the files are already written and the console shows the same report.
 */
export async function deliver(report, { recipients = RECIPIENTS, send = sendMail } = {}) {
  if (recipients.length === 0) return { sent: false, reason: 'no recipients' };
  const stamp = report.generated_at.slice(0, 10);
  const result = await send({
    to: recipients,
    subject: `JubileeSearch content-gap report, week to ${stamp}`,
    text: reportToText(report),
    attachments: [{ filename: `content-gap-${stamp}.csv`, content: reportToCsv(report), type: 'text/csv' }],
  });
  console.log(JSON.stringify({ level: result.success ? 'info' : 'error', at: 'job.content-gap.deliver',
    recipients: recipients.length, ...result }));
  return { sent: result.success, ...result };
}

export async function run(db = pool, { days = 7, dir = REPORTS_DIR, stdout = false, mail = true } = {}) {
  const report = await buildContentGapReport(db, { days });
  if (stdout) return { report, written: [] };
  await mkdir(dir, { recursive: true });
  const stamp = report.generated_at.slice(0, 10);
  const written = [];
  for (const [name, body] of [
    [`content-gap-${stamp}.json`, JSON.stringify(report, null, 2)],
    [`content-gap-${stamp}.csv`, reportToCsv(report)],
    ['content-gap-latest.json', JSON.stringify(report, null, 2)],
    ['content-gap-latest.csv', reportToCsv(report)],
  ]) {
    const path = join(dir, name);
    await writeFile(path, body, 'utf8');
    written.push(path);
  }
  const delivery = mail ? await deliver(report) : { sent: false, reason: 'disabled' };
  return { report, written, delivery };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice(7)) : 7;
  const stdout = process.argv.includes('--stdout');
  const { report, written, delivery } = await run(pool, { days, stdout, mail: !process.argv.includes('--no-mail') });
  if (stdout) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(JSON.stringify({
      level: 'info', at: 'job.content-gap', days,
      zero_result: report.zero_result.length, zone_a_empty: report.zone_a_empty.length,
      low_ctr: report.low_ctr.length, written, delivery,
    }));
  }
  await pool.end();
}
