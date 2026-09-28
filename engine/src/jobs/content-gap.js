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
// The Search analytics screen the mail's button opens.
const CONSOLE_URL = process.env.CONTENT_GAP_CONSOLE_URL || 'https://jubileesearch.com/admin/analytics';

/** @returns {Promise<object>} the report, ready to serialise */
export async function buildContentGapReport(db, { days = 7, minTimes = 2, minImpressions = 20, limit = 100, allLimit = 1000 } = {}) {
  const since = [String(days)];
  const [zero, empty, lowCtr, totals, all] = await Promise.all([
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
              count(*) FILTER (WHERE COALESCE(zone_a_count,0) = 0 AND COALESCE(zone_b_count,0) > 0) AS zone_a_empty,
              count(DISTINCT normalized) AS distinct_queries,
              min(created_at) AS first_search,
              max(created_at) AS last_search
         FROM search_queries
        WHERE created_at > now() - ($1 || ' days')::interval AND normalized <> ''`, since),
    // Every search in the window, aggregated on `normalized` (§17: no query is
    // tied to a person, so no session or Jubilee id travels with it). The three
    // lists above are drawn from these same rows; they go out as
    // all-searches.csv so the count in the mail and the rows in the file agree
    // even in a week where nothing crossed a threshold.
    db.query(
      `SELECT normalized AS query, lang, intent, count(*) AS times,
              max(COALESCE(zone_a_count, 0)) AS zone_a_results,
              max(COALESCE(zone_b_count, 0)) AS zone_b_results,
              count(*) FILTER (WHERE cache_hit) AS cache_hits,
              round(avg(latency_ms)) AS avg_latency_ms,
              min(created_at) AS first_seen, max(created_at) AS last_seen
         FROM search_queries
        WHERE created_at > now() - ($1 || ' days')::interval
          AND normalized <> ''
        GROUP BY 1, 2, 3
        ORDER BY count(*) DESC, max(created_at) DESC
        LIMIT $2`, [...since, allLimit]),
  ]);
  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    thresholds: { min_times: minTimes, min_impressions: minImpressions, low_ctr_below: 0.05 },
    totals: totals.rows[0],
    zero_result: zero.rows,
    zone_a_empty: empty.rows,
    low_ctr: lowCtr.rows,
    all_searches: all.rows,
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

/** One CSV with a `kind` column: the console download and the REPORTS_DIR file. */
export function reportToCsv(report) {
  const rows = [['kind', 'query', 'lang', 'intent', 'times', 'impressions', 'clicks', 'ctr', 'last_seen']];
  for (const r of report.zero_result) rows.push(['zero_result', r.query, r.lang, r.intent, r.times, '', '', '', r.last_seen]);
  for (const r of report.zone_a_empty) rows.push(['zone_a_empty', r.query, r.lang, r.intent, r.times, '', '', '', r.last_seen]);
  for (const r of report.low_ctr) rows.push(['low_ctr', r.query, '', '', '', r.impressions, r.clicks, r.ctr, '']);
  return csv(rows);
}

/** The outcome of a search, in the words the mail uses. */
function outcome(r) {
  const a = Number(r.zone_a_results); const b = Number(r.zone_b_results);
  if (a + b === 0) return 'nothing came back';
  if (a === 0) return 'wider web only';
  return 'answered';
}

/**
 * The per-category files the mail attaches. Each has its own header, and an
 * empty category still ships as a header-only file so the attachment list is
 * the same every week.
 */
export function reportToCsvFiles(report) {
  const demand = (xs) => csv([['query', 'lang', 'intent', 'times', 'last_seen'],
    ...xs.map((r) => [r.query, r.lang, r.intent, r.times, r.last_seen])]);
  return {
    'all-searches.csv': csv([
      ['query', 'lang', 'intent', 'times', 'outcome', 'zone_a_results', 'zone_b_results', 'cache_hits', 'avg_latency_ms', 'first_seen', 'last_seen'],
      ...(report.all_searches ?? []).map((r) => [r.query, r.lang, r.intent, r.times, outcome(r), r.zone_a_results,
        r.zone_b_results, r.cache_hits, r.avg_latency_ms, r.first_seen, r.last_seen])]),
    'nothing-came-back.csv': demand(report.zero_result),
    'wider-web-answered.csv': demand(report.zone_a_empty),
    'shown-not-clicked.csv': csv([['query', 'impressions', 'clicks', 'ctr'],
      ...report.low_ctr.map((r) => [r.query, r.impressions, r.clicks, r.ctr])]),
  };
}

// -- the mail ----------------------------------------------------------------

const SECTIONS = [
  { key: 'zero_result', title: 'Nothing came back', tone: '#c2410c',
    what: 'People searched for this and got no results at all: no page in the network, and the wider web was not admitted either.',
    why: 'Pure demand. Nobody has written it yet.' },
  { key: 'zone_a_empty', title: 'The wider web answered, Jubilee did not', tone: '#b45309',
    what: 'The wider web had an answer but no page in the Jubilee network did, so the reader left the network for it.',
    why: 'The sharpest assignment of the three.' },
  { key: 'low_ctr', title: 'Shown and not clicked', tone: '#6d28d9',
    what: 'Jubilee pages were shown for this search at least 20 times and fewer than 1 in 20 readers clicked one.',
    why: 'Either the pages are wrong for the question, or their titles are.' },
];

const period = (report) => {
  const to = new Date(report.generated_at);
  const from = new Date(to.getTime() - report.window_days * 86400000);
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${fmt(from)} to ${fmt(to)}`;
};
const num = (v) => Number(v ?? 0).toLocaleString('en-US');
const rows = (n) => `${num(n)} ${n === 1 ? 'row' : 'rows'}`;
const pct = (ctr) => `${(Number(ctr) * 100).toFixed(1)}%`;

/** The plain-text body: the fallback for readers whose client shows no HTML. */
export function reportToText(report, { top = 10 } = {}) {
  const t = report.totals;
  const line = (r) => `  ${r.query}${r.lang ? ` (${r.lang})` : ''}` + (r.times ? `  x${r.times}` : '')
    + (r.ctr !== undefined ? `  ${r.impressions} shown, ${r.clicks} clicks` : '');
  const section = (s) => {
    const xs = report[s.key];
    return [`${s.title} (${xs.length})`, `  ${s.what}`,
      ...(xs.length ? xs.slice(0, top).map(line) : ['  No searches crossed this threshold this week.']),
      xs.length > top ? `  ... ${xs.length - top} more in the CSV` : '', ''];
  };
  return [
    'JubileeSearch content-gap report',
    `Reporting period: ${period(report)} (${report.window_days} days)`, '',
    'SUMMARY',
    `  Total searches: ${num(t.searches)}`,
    `  Searches with no results: ${num(t.zero_result)}`,
    `  Answered by the wider web, not by Jubilee: ${num(t.zone_a_empty)}`,
    `  Results shown but not clicked: ${report.low_ctr.length} search terms`, '',
    'A search becomes a writing assignment when it recurs: a term must be searched at least',
    `${report.thresholds.min_times} times (or shown ${report.thresholds.min_impressions} times) in the period to appear in a category below.`,
    'The totals above count every search; the categories count only those that crossed that bar.', '',
    ...SECTIONS.flatMap(section),
    'ATTACHMENTS',
    `  all-searches.csv          every search in the period (${(report.all_searches ?? []).length} terms)`,
    `  nothing-came-back.csv     ${rows(report.zero_result.length)}`,
    `  wider-web-answered.csv    ${rows(report.zone_a_empty.length)}`,
    `  shown-not-clicked.csv     ${rows(report.low_ctr.length)}`, '',
    `Search analytics dashboard: ${CONSOLE_URL}`,
  ].join('\n');
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The HTML body: table layout and inline styles, so Gmail and Outlook agree. */
export function reportToHtml(report, { top = 10 } = {}) {
  const t = report.totals;
  const font = "font-family:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  // Inline-block columns wrap to two per row on a phone with no media query,
  // which Gmail and the Outlook apps all honour.
  const stat = (label, value, hint) => `<div style="display:inline-block;vertical-align:top;width:25%;min-width:130px;box-sizing:border-box;padding:6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
        <tr><td style="padding:14px 12px;${font}">
          <div style="font-size:26px;line-height:30px;font-weight:700;color:#0f172a;">${esc(value)}</div>
          <div style="font-size:12px;line-height:16px;color:#475569;margin-top:4px;">${esc(label)}</div>
          ${hint ? `<div style="font-size:11px;line-height:14px;color:#94a3b8;margin-top:2px;">${esc(hint)}</div>` : ''}
        </td></tr>
      </table>
    </div>`;
  const rowsOf = (s, xs) => {
    if (!xs.length) {
      return `<tr><td colspan="3" style="padding:12px 16px;${font}font-size:13px;color:#64748b;background:#f8fafc;border-top:1px solid #e5e7eb;">
        No searches crossed this threshold in the period. The CSV for this category is attached with headers only.</td></tr>`;
    }
    const cell = (v, right) => `<td style="padding:8px 16px;${font}font-size:13px;color:#0f172a;border-top:1px solid #e5e7eb;${right ? 'text-align:right;white-space:nowrap;' : ''}">${v}</td>`;
    const head = s.key === 'low_ctr' ? ['Search term', 'Shown', 'Clicked'] : ['Search term', 'Language', 'Times searched'];
    const body = xs.slice(0, top).map((r) => (s.key === 'low_ctr'
      ? `<tr>${cell(esc(r.query))}${cell(num(r.impressions), true)}${cell(`${num(r.clicks)} (${pct(r.ctr)})`, true)}</tr>`
      : `<tr>${cell(esc(r.query))}${cell(esc(r.lang || ''))}${cell(num(r.times), true)}</tr>`)).join('');
    const more = xs.length > top ? `<tr><td colspan="3" style="padding:8px 16px;${font}font-size:12px;color:#64748b;border-top:1px solid #e5e7eb;">and ${xs.length - top} more in the attached CSV</td></tr>` : '';
    return `<tr>${head.map((h, i) => `<th align="${i ? 'right' : 'left'}" style="padding:8px 16px;${font}font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-top:1px solid #e5e7eb;">${h}</th>`).join('')}</tr>${body}${more}`;
  };
  const card = (s) => {
    const xs = report[s.key];
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 16px;border-collapse:separate;">
      <tr><td style="padding:16px 16px 12px;border-left:4px solid ${s.tone};border-radius:8px 0 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="${font}font-size:16px;line-height:22px;font-weight:700;color:#0f172a;">${esc(s.title)}</td>
          <td align="right" style="${font}white-space:nowrap;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${xs.length ? s.tone : '#e2e8f0'};color:${xs.length ? '#ffffff' : '#475569'};font-size:12px;font-weight:700;">${xs.length} ${xs.length === 1 ? 'term' : 'terms'}</span></td>
        </tr></table>
        <div style="${font}font-size:13px;line-height:19px;color:#475569;margin-top:6px;">${esc(s.what)} <span style="color:#0f172a;">${esc(s.why)}</span></div>
      </td></tr>
      <tr><td style="padding:0;border-left:4px solid ${s.tone};border-radius:0 0 0 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsOf(s, xs)}</table></td></tr>
    </table>`;
  };
  const attachments = [
    ['all-searches.csv', `every search in the period, ${num((report.all_searches ?? []).length)} terms`],
    ['nothing-came-back.csv', rows(report.zero_result.length)],
    ['wider-web-answered.csv', rows(report.zone_a_empty.length)],
    ['shown-not-clicked.csv', rows(report.low_ctr.length)],
  ];
  const assignments = report.zero_result.length + report.zone_a_empty.length + report.low_ctr.length;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>JubileeSearch content-gap report</title>
<style>
  @media only screen and (max-width:620px){
    .wrap{width:100%!important}
    .pad{padding-left:12px!important;padding-right:12px!important}
  }
</style></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<div style="display:none;max-height:0;overflow:hidden;${font}">${esc(num(t.searches))} searches, ${assignments} writing ${assignments === 1 ? 'assignment' : 'assignments'}. ${esc(period(report))}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">

  <tr><td class="pad" style="background:#0b1220;border-radius:10px 10px 0 0;padding:22px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="${font}font-size:22px;line-height:26px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Jubilee<span style="color:#3DA5FF;">Search</span><span style="color:#8e8e8e;font-weight:400;">.com</span></td>
      <td align="right" style="${font}font-size:11px;line-height:16px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;">Weekly report</td>
    </tr></table>
    <div style="${font}font-size:24px;line-height:30px;font-weight:700;color:#ffffff;margin-top:18px;">Content-gap report</div>
    <div style="${font}font-size:14px;line-height:20px;color:#cbd5e1;margin-top:4px;">${esc(period(report))} &middot; ${report.window_days} days</div>
  </td></tr>

  <tr><td class="pad" style="background:#ffffff;padding:20px 22px 8px;">
    <div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700;padding:0 6px;">Summary</div>
    <div style="margin-top:8px;font-size:0;line-height:0;">${stat('Total searches', num(t.searches), `${num(t.distinct_queries)} distinct ${Number(t.distinct_queries) === 1 ? 'term' : 'terms'}`)}${stat('No results at all', num(t.zero_result), 'of all searches')}${stat('Wider web only', num(t.zone_a_empty), 'Jubilee had no page')}${stat('Shown, not clicked', num(report.low_ctr.length), 'search terms')}</div>
    <div style="${font}font-size:13px;line-height:19px;color:#475569;padding:12px 6px 8px;">
      The four numbers above count <strong style="color:#0f172a;">every search</strong> in the period.
      The three categories below list only the searches that <strong style="color:#0f172a;">recur</strong>:
      a term must be searched at least ${report.thresholds.min_times} times, or shown ${report.thresholds.min_impressions} times, before it becomes a writing assignment.
      A busy week with nothing below is a good week; a quiet week with nothing below is just quiet.
    </div>
  </td></tr>

  <tr><td class="pad" style="background:#f8fafc;padding:20px 22px 6px;border-top:1px solid #e5e7eb;">
    <div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:12px;">Writing assignments</div>
    ${SECTIONS.map(card).join('')}
  </td></tr>

  <tr><td class="pad" style="background:#ffffff;padding:20px 22px;border-top:1px solid #e5e7eb;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
      <td style="background:#3DA5FF;border-radius:6px;">
        <a href="${esc(CONSOLE_URL)}" style="display:inline-block;padding:12px 24px;${font}font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Open Search analytics</a>
      </td>
    </tr></table>
    <div style="${font}font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700;margin-top:22px;">Attached files</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
      ${attachments.map(([name, desc]) => `<tr><td style="padding:5px 0;${font}font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;"><code style="font-family:Consolas,Menlo,monospace;font-size:12px;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${esc(name)}</code></td><td align="right" style="padding:5px 0;${font}font-size:13px;color:#475569;border-bottom:1px solid #f1f5f9;">${esc(desc)}</td></tr>`).join('')}
    </table>
  </td></tr>

  <tr><td class="pad" style="background:#0b1220;border-radius:0 0 10px 10px;padding:16px 28px;${font}font-size:12px;line-height:18px;color:#94a3b8;">
    Searches are counted in aggregate; no search is tied to a reader. Generated ${esc(report.generated_at.slice(0, 16).replace('T', ' '))} UTC by JubileeSearch.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

/**
 * Send the report to CONTENT_GAP_RECIPIENTS with the CSVs attached. No
 * recipients, no send; a failed send is logged and does not fail the job --
 * the files are already written and the console shows the same report.
 */
export async function deliver(report, { recipients = RECIPIENTS, send = sendMail } = {}) {
  if (recipients.length === 0) return { sent: false, reason: 'no recipients' };
  const stamp = report.generated_at.slice(0, 10);
  const files = reportToCsvFiles(report);
  const result = await send({
    to: recipients,
    subject: `JubileeSearch content-gap report, week to ${stamp}`,
    text: reportToText(report),
    html: reportToHtml(report),
    attachments: Object.entries(files).map(([filename, content]) => ({ filename, content, type: 'text/csv' })),
  });
  console.log(JSON.stringify({ level: result.success ? 'info' : 'error', at: 'job.content-gap.deliver',
    recipients: recipients.length, attachments: Object.keys(files), ...result }));
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
    ...Object.entries(reportToCsvFiles(report)).map(([name, body]) => [`content-gap-${stamp}-${name}`, body]),
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
