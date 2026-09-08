// Nightly click rollup with position-bias correction (R7, Appendix A.3).
//
// Acceptance criterion 18: "Position-bias correction is implemented and
// demonstrably changes CTR ordering versus raw CTR on real logged data."
// `--compare` prints exactly that comparison.
//
// Why the correction is not optional: users click the top result because it is
// the top result, not only because it is the best one. Feeding raw CTR back into
// ranking makes whatever is already first get more first-ness, and the loop
// closes on itself within a week. Dividing each click by the probability that
// its slot was examined at all is what breaks that circuit.

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';

// Appendix A.3, verbatim apart from the ON CONFLICT list being spelled out.
const ROLLUP = `
INSERT INTO query_page_ctr (normalized_query, page_id, impressions, clicks,
                            raw_ctr, corrected_ctr, confidence, updated_at)
SELECT sq.normalized,
       ri.page_id,
       COUNT(*) AS impressions,
       COUNT(*) FILTER (WHERE ri.clicked) AS clicks,
       COUNT(*) FILTER (WHERE ri.clicked)::numeric / COUNT(*) AS raw_ctr,
       SUM(CASE WHEN ri.clicked THEN 1.0 / pb.examination_prob ELSE 0 END)
         / NULLIF(SUM(1.0 / pb.examination_prob), 0) AS corrected_ctr,
       LEAST(COUNT(*)::numeric / 50.0, 1.0) AS confidence,  -- full trust at 50 impressions
       now()
FROM result_impressions ri
JOIN search_queries sq ON sq.id = ri.query_id
JOIN position_bias pb ON pb.zone = ri.zone AND pb.position = ri.position
WHERE sq.created_at >= now() - INTERVAL '90 days'
GROUP BY sq.normalized, ri.page_id
HAVING COUNT(*) >= 5
ON CONFLICT (normalized_query, page_id) DO UPDATE
   SET impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       raw_ctr = EXCLUDED.raw_ctr,
       corrected_ctr = EXCLUDED.corrected_ctr,
       confidence = EXCLUDED.confidence,
       updated_at = now()`;

export async function run(db = pool) {
  const { rowCount } = await db.query(ROLLUP);

  // Rows that fall out of the 90-day window stop being refreshed by the upsert
  // above but are not removed by it, so they would keep boosting forever on
  // evidence that no longer exists.
  const { rowCount: stale } = await db.query(
    `DELETE FROM query_page_ctr WHERE updated_at < now() - interval '7 days'`);

  // Also mirror the strongest signal onto pages.ctr_signal, which §7.2 declares
  // and the admin console reads for a per-page view. Ranking itself joins
  // query_page_ctr, because CTR is a property of a (query, page) pair and
  // flattening it to the page loses the query.
  await db.query(`
    UPDATE pages p SET ctr_signal = best.corrected_ctr
    FROM (SELECT DISTINCT ON (page_id) page_id, corrected_ctr
            FROM query_page_ctr ORDER BY page_id, impressions DESC) best
    WHERE p.id = best.page_id
      AND p.ctr_signal IS DISTINCT FROM best.corrected_ctr`);

  return { rows_rolled_up: rowCount, stale_rows_removed: stale };
}

/**
 * Acceptance criterion 18's evidence. Ranks the same (query, page) pairs by raw
 * CTR and by corrected CTR and reports where they disagree.
 */
export async function compare(db = pool, limit = 25) {
  const { rows } = await db.query(`
    WITH ranked AS (
        SELECT normalized_query, page_id, impressions, raw_ctr, corrected_ctr,
               ROW_NUMBER() OVER (PARTITION BY normalized_query ORDER BY raw_ctr DESC)       AS raw_rank,
               ROW_NUMBER() OVER (PARTITION BY normalized_query ORDER BY corrected_ctr DESC) AS corrected_rank
        FROM query_page_ctr
    )
    SELECT r.normalized_query, r.page_id, p.url, p.title,
           r.impressions, r.raw_ctr, r.corrected_ctr,
           r.raw_rank, r.corrected_rank,
           r.raw_rank - r.corrected_rank AS movement
    FROM ranked r JOIN pages p ON p.id = r.page_id
    WHERE r.raw_rank <> r.corrected_rank
    ORDER BY abs(r.raw_rank - r.corrected_rank) DESC, r.impressions DESC
    LIMIT $1`, [limit]);

  const { rows: totals } = await db.query(`
    WITH ranked AS (
        SELECT normalized_query, page_id,
               ROW_NUMBER() OVER (PARTITION BY normalized_query ORDER BY raw_ctr DESC)       AS raw_rank,
               ROW_NUMBER() OVER (PARTITION BY normalized_query ORDER BY corrected_ctr DESC) AS corrected_rank
        FROM query_page_ctr)
    SELECT count(*) AS pairs,
           count(*) FILTER (WHERE raw_rank <> corrected_rank) AS reordered
    FROM ranked`);

  return { ...totals[0], examples: rows };
}

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run();
  console.log(JSON.stringify({ level: 'info', at: 'job.ctr-rollup', ...result }));
  if (process.argv.includes('--compare')) {
    const c = await compare();
    console.log(JSON.stringify({ level: 'info', at: 'job.ctr-rollup.compare', ...c }, null, 2));
  }
  await pool.end();
}
