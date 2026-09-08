// Engagement and quality scoring (R8, §7.2, §16).
//
// §16: "Inbound, a nightly job pulls per-URL dwell, scroll depth, bounce, and
// completion for T1 pages and computes engagement_score, which feeds Zone A
// ranking (R8). This is only possible because Jubilee owns both systems, and it
// is a signal no external engine has."
//
// That last sentence is the reason the engagement weight (0.20) is the second
// largest in §13.6 and larger than the structural quality weight (0.15). P9:
// "Where Jubilee owns both the content and the measurement, real engagement
// outranks structural guesswork."
//
// Acceptance criterion 19: engagement scores populate for at least 90% of T1
// pages with traffic.

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { env } from '../config.js';

const WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Engagement composite.
//
// The five inputs §16 names, normalised to 0-100 and weighted. The weights are
// here rather than in ranking_config because they compose one signal rather than
// tuning the ranker; §13.6's w_engage is the dial that decides how much that
// signal counts, and having two sets of dials for one effect makes both
// untunable.
//
// Dwell and scroll dominate because they are the hardest to fake and the closest
// to "did this answer the question". Pageviews are log-scaled and weighted least:
// popularity is a fact about the link that was clicked, not about the page.
// ---------------------------------------------------------------------------
const WEIGHTS = { dwell: 0.30, scroll: 0.25, completion: 0.20, bounce: 0.15, views: 0.10 };

// A reader who stays three minutes has engaged; more than that is not more
// engaged, it is a longer article. Saturating rather than scaling linearly stops
// long-form content from outscoring short content that answered the question.
const DWELL_SATURATION_MS = 180_000;
const VIEWS_SATURATION = 1000;

// A missing metric contributes nothing, and is not the same as a metric that
// came back at zero. Bounce rate is where this bites: read as "0% bounce", an
// absent value hands every unmeasured page 15 free points, and a page Analytics
// has never seen would outrank one that was genuinely read badly. Absent means
// no evidence, and no evidence earns no score.
//
// The components are not renormalised over whatever data did arrive, either.
// A page with only a pageview count scores like a page with only a pageview
// count -- partial evidence is a weaker signal, and saying so is the point.
export function engagementScore(m) {
  const parts = [
    [WEIGHTS.dwell, ratio(m.median_dwell_ms, DWELL_SATURATION_MS)],
    [WEIGHTS.scroll, ratio(m.scroll_depth_pct, 100)],
    [WEIGHTS.completion, ratio(m.completion_rate, 100)],
    [WEIGHTS.bounce, present(m.bounce_rate) ? 1 - clamp01(Number(m.bounce_rate) / 100) : null],
    [WEIGHTS.views, present(m.pageviews)
      ? clamp01(Math.log10(1 + Number(m.pageviews)) / Math.log10(1 + VIEWS_SATURATION))
      : null],
  ];

  const raw = parts.reduce((sum, [weight, value]) => sum + (value === null ? 0 : weight * value), 0);
  return Math.round(raw * 10000) / 100;   // 0.00 to 100.00
}

const present = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const ratio = (v, saturation) => (present(v) ? clamp01(Number(v) / saturation) : null);
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Pull the window from Jubilee Analytics and store it.
 *
 * The Analytics contract is not specified in the document, so this expects the
 * shape §16 describes -- per-URL dwell, scroll depth, bounce, completion -- and
 * fails loudly on anything else rather than quietly scoring every page zero. A
 * zero engagement_score is indistinguishable from a page nobody read, and Zone A
 * would rank on it.
 */
export async function pullAnalytics(db = pool) {
  if (!env.analyticsApiUrl) {
    return { skipped: 'ANALYTICS_API_URL is not configured; engagement scoring is inert' };
  }

  const { rows: pages } = await db.query(
    `SELECT id, url FROM pages WHERE tier = 'T1' AND status = 'indexed'`);
  if (pages.length === 0) return { pages: 0 };

  const byUrl = new Map(pages.map((p) => [p.url, Number(p.id)]));
  let updated = 0;
  let missing = 0;

  // Batched by URL so a network with 10,000 T1 pages makes tens of calls, not
  // ten thousand.
  for (const batch of chunk([...byUrl.keys()], 200)) {
    const metrics = await fetchMetrics(batch);
    const rows = [];
    for (const url of batch) {
      const m = metrics.get(url);
      if (!m) { missing++; continue; }
      rows.push([byUrl.get(url), m]);
    }
    if (rows.length === 0) continue;

    await db.query(
      `INSERT INTO page_engagement
         (page_id, window_days, pageviews, median_dwell_ms, scroll_depth_pct,
          bounce_rate, completion_rate, engagement_score, computed_at)
       SELECT u.*, now()
         FROM unnest($1::bigint[], $2::int[], $3::int[], $4::int[],
                     $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
              AS u(page_id, window_days, pageviews, median_dwell_ms,
                   scroll_depth_pct, bounce_rate, completion_rate, engagement_score)
       ON CONFLICT (page_id) DO UPDATE SET
          window_days = EXCLUDED.window_days, pageviews = EXCLUDED.pageviews,
          median_dwell_ms = EXCLUDED.median_dwell_ms, scroll_depth_pct = EXCLUDED.scroll_depth_pct,
          bounce_rate = EXCLUDED.bounce_rate, completion_rate = EXCLUDED.completion_rate,
          engagement_score = EXCLUDED.engagement_score, computed_at = now()`,
      [rows.map((r) => r[0]), rows.map(() => WINDOW_DAYS),
       rows.map((r) => r[1].pageviews ?? null), rows.map((r) => r[1].median_dwell_ms ?? null),
       rows.map((r) => r[1].scroll_depth_pct ?? null), rows.map((r) => r[1].bounce_rate ?? null),
       rows.map((r) => r[1].completion_rate ?? null), rows.map((r) => engagementScore(r[1]))]);
    updated += rows.length;
  }

  // Mirror onto pages, which is what the Zone A boost reads -- one join fewer on
  // the request path, and §7.2 declares the column.
  await db.query(
    `UPDATE pages p SET engagement_score = e.engagement_score
       FROM page_engagement e
      WHERE e.page_id = p.id
        AND p.engagement_score IS DISTINCT FROM e.engagement_score`);

  const coverage = pages.length ? updated / pages.length : 0;
  return {
    pages: pages.length, updated, missing,
    coverage: Math.round(coverage * 1000) / 10,
    // Acceptance criterion 19 wants 90% of T1 pages *with traffic*; pages with
    // no traffic legitimately have no row, so this is reported rather than
    // asserted.
    meets_acceptance_19: coverage >= 0.9,
  };
}

async function fetchMetrics(urls) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${env.analyticsApiUrl.replace(/\/$/, '')}/v1/pages/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls, window_days: WINDOW_DAYS }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`analytics returned ${res.status}`);
    const json = await res.json();
    const list = json?.pages ?? json?.data;
    if (!Array.isArray(list)) throw new Error('analytics response has no pages array');
    return new Map(list.map((m) => [m.url, m]));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Structural quality (§7.2 quality_score, "recomputed nightly").
//
// The spec declares the column and its weight but not its formula, so this is a
// starting definition, and it is deliberately made of things that are true of a
// page rather than things that are true of its traffic -- engagement already
// covers the latter, and double-counting popularity would let one busy page win
// twice.
//
// It is a heuristic and should be revisited against the gold set once one
// exists. w_quality is the smaller weight (0.15) precisely because of that.
// ---------------------------------------------------------------------------
export async function recomputeQuality(db = pool) {
  const { rowCount } = await db.query(`
    UPDATE pages p SET quality_score = round(LEAST(100, GREATEST(0,
          -- Substance. Under 300 words scores partially; the curve flattens at
          -- about 1,200, past which more words are not more quality.
          30 * LEAST(1.0, ln(1 + COALESCE(p.word_count, 0)) / ln(1201))
          -- Metadata completeness. Every one of these comes free from frontmatter
          -- on a T1 page (R5), so a gap here is a content problem worth surfacing.
        + 10 * (CASE WHEN p.title       IS NOT NULL THEN 1 ELSE 0 END)
        +  8 * (CASE WHEN p.description IS NOT NULL THEN 1 ELSE 0 END)
        +  6 * (CASE WHEN p.category    IS NOT NULL THEN 1 ELSE 0 END)
        +  6 * (CASE WHEN p.published_at IS NOT NULL THEN 1 ELSE 0 END)
        +  5 * (CASE WHEN COALESCE(array_length(p.tags, 1), 0) > 0 THEN 1 ELSE 0 END)
        +  5 * (CASE WHEN p.author      IS NOT NULL THEN 1 ELSE 0 END)
          -- Standing in the network's own link graph.
        + 20 * LEAST(1.0, ln(1 + COALESCE(p.inlink_count, 0)) / ln(51))
          -- A page that keeps failing to fetch is a page in trouble.
        + 10 * (CASE WHEN COALESCE(p.fetch_failures, 0) = 0 THEN 1 ELSE 0 END)
    ))::numeric, 2)
    WHERE p.status = 'indexed'`);
  return { pages_scored: rowCount };
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const quality = await recomputeQuality();
  const analytics = await pullAnalytics();
  console.log(JSON.stringify({ level: 'info', at: 'job.engagement', quality, analytics }, null, 2));
  await pool.end();
}
