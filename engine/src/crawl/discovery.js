// Trust-graph discovery (§10.2) and the candidate lifecycle.
//
// §10.1 is unusually blunt about what this must not be: "Crawling 'the
// Internet' is not a feature that can be switched on... **Do not attempt a broad
// web crawl.**" What replaces it is the web's own link structure:
//
//   "Start from the T2 whitelist. Follow outbound links to a limited depth. A
//    site linked to by three or more independent trusted sites becomes a
//    candidate. Candidates run the full safety pipeline before any page is
//    indexed. The web's own link structure does the discovery work, and the seed
//    set guarantees topical relevance."
//
// So nothing here fetches anything. Discovery is a query over links the crawler
// already recorded while doing its ordinary work, and its output is a row in a
// review queue — never a page in the index.
//
// The lifecycle, and every gate in it:
//
//   nominate   >= 3 distinct T1/T2 domains link to a host (§10.2)
//   screen     gate 1, domain reputation, before a single request (§11.1)
//   probe      promoted to T0 with a 20-page cap; crawled and classified (§10.2)
//   promote    a passing sample moves it to T3; anything else stays or is rejected
//
// A T2 nomination skips the first two steps and goes straight to a human,
// because §11.4 puts doctrinal judgement there and nowhere else: "T2 whitelist
// membership is a human editorial decision."

import { gateDomain, loadRules } from '../safety/gates.js';

/**
 * §10.2's rule, as a query.
 *
 * "A candidate domain must be independently linked by at least 3 distinct T1 or
 * T2 domains, or be manually nominated."
 *
 * Independence is the load-bearing word and it is why this counts distinct
 * *linking domains* rather than links. A single site with a links page pointing
 * at forty ministries is one opinion, not forty; counting links would let any
 * one property nominate the whole of its blogroll.
 *
 * Excluded from the count:
 *   - hosts already in `domains`, at any tier or status — including `blocked`,
 *     so a domain someone blocked cannot be renominated by the graph a week later
 *   - hosts already carrying a candidate row that was rejected
 *   - `rel="nofollow"` links, which are the linking site declining to vouch
 */
const NOMINATE_SQL = `
  WITH trusted_links AS (
      SELECT l.to_host,
             d.host AS from_host,
             min(l.to_url) AS sample_url
        FROM links l
        JOIN pages p  ON p.id = l.from_page_id
        JOIN domains d ON d.id = p.domain_id
       WHERE NOT l.is_internal
         AND l.to_host IS NOT NULL
         AND l.to_host <> ''
         AND d.tier IN ('T1','T2')
         AND d.status = 'active'
         AND COALESCE(l.rel, '') NOT LIKE '%nofollow%'
       GROUP BY l.to_host, d.host
  )
  SELECT tl.to_host AS host,
         count(*)                       AS linking_domains,
         array_agg(DISTINCT tl.from_host) AS linking_hosts,
         (array_agg(tl.sample_url))[1:5]  AS sample_urls
    FROM trusted_links tl
   WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.host = tl.to_host)
     AND NOT EXISTS (
           SELECT 1 FROM domain_candidates c
            WHERE c.host = tl.to_host AND c.status IN ('rejected','promoted'))
   GROUP BY tl.to_host
  HAVING count(*) >= $1
   ORDER BY count(*) DESC
   LIMIT $2`;

/**
 * Find hosts the trust graph now vouches for, and record them as candidates.
 * Idempotent: a host already nominated has its evidence refreshed rather than
 * duplicated, because the count only ever grows as the crawl continues.
 */
export async function nominateFromTrustGraph(db, cfg, { limit = 200 } = {}) {
  const threshold = Math.max(1, Math.round(cfg.discovery_min_linking_domains ?? 3));
  const { rows } = await db.query(NOMINATE_SQL, [threshold, limit]);
  if (rows.length === 0) return { examined: 0, nominated: 0, refreshed: 0 };

  // Passed as JSON, not as parallel arrays. Two of these columns are themselves
  // arrays, and Postgres has no array-of-arrays: a `text[][]` is one flat
  // multidimensional array, so `unnest` on it dissolves the per-row grouping
  // entirely rather than yielding one array per row. JSON keeps the shape.
  const payload = rows.map((r) => ({
    host: r.host,
    n: Number(r.linking_domains),
    hosts: r.linking_hosts ?? [],
    samples: r.sample_urls ?? [],
  }));

  const { rows: written } = await db.query(
    `INSERT INTO domain_candidates
        (host, target_tier, source, linking_domains, linking_hosts, sample_urls)
     SELECT c->>'host', 'T3', 'trust_graph', (c->>'n')::int,
            ARRAY(SELECT jsonb_array_elements_text(c->'hosts')),
            ARRAY(SELECT jsonb_array_elements_text(c->'samples'))
       FROM jsonb_array_elements($1::jsonb) AS c
     ON CONFLICT (host) DO UPDATE
        SET linking_domains = EXCLUDED.linking_domains,
            linking_hosts   = EXCLUDED.linking_hosts,
            sample_urls     = EXCLUDED.sample_urls,
            last_seen_at    = now()
     RETURNING (xmax = 0) AS inserted`,
    [JSON.stringify(payload)]);

  const nominated = written.filter((r) => r.inserted).length;
  return {
    examined: rows.length,
    nominated,
    refreshed: written.length - nominated,
    threshold,
  };
}

/**
 * §10.3: "Queries that return nothing in either zone are logged and reviewed...
 * they are seeds for targeted whitelist nomination when the gap is genuinely
 * outside Jubilee's scope."
 *
 * This does not nominate anything. It surfaces the gaps for a person, because
 * deciding that a subject is outside Jubilee's scope is exactly the editorial
 * call §11.4 refuses to automate.
 */
export async function zeroResultGaps(db, { days = 30, minOccurrences = 3, limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT normalized, lang, intent, count(*) AS times, max(created_at) AS last_seen
       FROM search_queries
      WHERE COALESCE(zone_a_count, 0) + COALESCE(zone_b_count, 0) = 0
        AND created_at > now() - ($1 || ' days')::interval
        AND normalized <> ''
      GROUP BY normalized, lang, intent
     HAVING count(*) >= $2
      ORDER BY count(*) DESC
      LIMIT $3`,
    [String(days), minOccurrences, limit]);
  return rows;
}

/**
 * Gate 1 against a candidate host, before anything is fetched from it.
 *
 * §11.1 puts domain reputation first precisely so it costs nothing: "Check the
 * host against blocklist_entries before spending a single request." A candidate
 * that fails here is rejected without the crawler ever learning its IP.
 */
export async function screenCandidates(db, { limit = 100 } = {}) {
  const rules = await loadRules(db);

  const { rows } = await db.query(
    `SELECT id, host FROM domain_candidates
      WHERE status = 'nominated' AND target_tier = 'T3'
      ORDER BY linking_domains DESC
      LIMIT $1`, [limit]);

  let cleared = 0;
  let blocked = 0;

  for (const candidate of rows) {
    const verdict = gateDomain(candidate.host, rules);
    const outcome = verdict.blocked ? 'blocked'
      : verdict.allowlisted ? 'allowlisted'
      : 'clear';

    await db.query(
      `UPDATE domain_candidates
          SET status = $2::candidate_status,
              screening_verdict = $3,
              screening_reasons = $4::jsonb,
              screened_at = now(),
              review_notes = CASE WHEN $2 = 'rejected'
                                  THEN 'Refused by gate 1 domain reputation.'
                                  ELSE review_notes END
        WHERE id = $1`,
      [candidate.id,
       verdict.blocked ? 'rejected' : 'screening',
       outcome,
       JSON.stringify(verdict.reasons ?? [])]);

    if (verdict.blocked) blocked++; else cleared++;
  }

  return { screened: rows.length, cleared, blocked };
}

/**
 * Promote a screened candidate into the registry as a probe.
 *
 * §10.2: "No candidate domain is crawled beyond 20 pages until it has passed
 * domain-level classification." So it enters at **T0**, not T3 — quarantine,
 * which `servable_pages` excludes outright — with the page cap applied. Nothing
 * it contains can reach a reader until `promoteProbed` moves it.
 */
export async function beginProbe(db, candidateId, cfg, actor) {
  const probePages = Math.max(1, Math.round(cfg.discovery_probe_pages ?? 20));

  const { rows } = await db.query(
    `WITH candidate AS (
        SELECT * FROM domain_candidates WHERE id = $1 AND status IN ('screening','approved')
     ), created AS (
        INSERT INTO domains (host, tier, status, ingest_mode, crawl_interval_hours,
                             max_pages, max_depth, crawl_delay_ms, respect_robots,
                             approval_notes)
        SELECT c.host, 'T0', 'active', 'crawl', 720, $2, 2, 2500, TRUE,
               'Trust-graph candidate probe, begun by ' || $3
          FROM candidate c
        ON CONFLICT (host) DO NOTHING
        RETURNING id, host
     )
     UPDATE domain_candidates
        SET promoted_domain_id = (SELECT id FROM created),
            review_notes = COALESCE(review_notes, '') ||
                           ' Probe of ' || $2::text || ' pages begun.'
      WHERE id = $1
      RETURNING host, promoted_domain_id`,
    [candidateId, probePages, actor]);

  if (!rows[0]) return { started: false, reason: 'no such candidate, or not screened' };
  return { started: true, host: rows[0].host, domain_id: rows[0].promoted_domain_id, probe_pages: probePages };
}

/**
 * Move a probed candidate from T0 to T3, or reject it.
 *
 * The test is the sample's own pass rate through the safety pipeline. §11.1's
 * gate 3 already classified every probe page individually; this asks whether the
 * *site* is the kind of place worth keeping, which is a different question from
 * whether any one page was clean.
 *
 * A domain that produced no classifiable pages is not promoted. Silence is not
 * a pass — the same reasoning as §13.2's scripture card.
 */
export async function promoteProbed(db, cfg, { limit = 25 } = {}) {
  const minPassRate = Number(cfg.discovery_min_pass_rate ?? 0.9);
  const probePages = Math.max(1, Math.round(cfg.discovery_probe_pages ?? 20));

  const { rows } = await db.query(
    `SELECT c.id, c.host, d.id AS domain_id,
            count(p.id)                                              AS fetched,
            count(p.id) FILTER (WHERE p.safety_verdict = 'safe')     AS passed,
            count(p.id) FILTER (WHERE p.safety_verdict = 'unsafe')   AS failed
       FROM domain_candidates c
       JOIN domains d ON d.id = c.promoted_domain_id AND d.tier = 'T0'
       LEFT JOIN pages p ON p.domain_id = d.id
      WHERE c.status IN ('screening','approved')
      GROUP BY c.id, c.host, d.id
     HAVING count(p.id) > 0
      LIMIT $1`, [limit]);

  const decisions = [];

  for (const row of rows) {
    const fetched = Number(row.fetched);
    const passed = Number(row.passed);
    const rate = fetched > 0 ? passed / fetched : 0;

    // Still gathering. A site with four pages crawled has not been sampled yet.
    if (fetched < Math.min(probePages, 5)) {
      decisions.push({ host: row.host, decision: 'probing', fetched, pass_rate: round(rate) });
      continue;
    }

    if (rate >= minPassRate) {
      await db.query(
        `WITH promoted AS (
            UPDATE domains SET tier = 'T3', max_pages = 500, max_depth = 2,
                               approval_notes = 'Promoted from trust-graph probe'
             WHERE id = $2 RETURNING id)
         UPDATE domain_candidates
            SET status = 'promoted', reviewed_at = now(), reviewed_by = 'discovery',
                review_notes = 'Probe passed at ' || $3::text || '; promoted to T3.'
          WHERE id = $1`,
        [row.id, row.domain_id, `${Math.round(rate * 100)}%`]);
      decisions.push({ host: row.host, decision: 'promoted', fetched, pass_rate: round(rate) });
    } else {
      // §11.1 is deliberately aggressive about this, and so is this: a site that
      // could not keep 90% of a twenty-page sample clean is not one to keep
      // sampling. Purging the pages with it means nothing lingers in T0.
      await db.query(
        `WITH purged AS (DELETE FROM pages WHERE domain_id = $2),
              dropped AS (DELETE FROM crawl_queue WHERE domain_id = $2),
              gone AS (DELETE FROM domains WHERE id = $2)
         UPDATE domain_candidates
            SET status = 'rejected', reviewed_at = now(), reviewed_by = 'discovery',
                promoted_domain_id = NULL,
                review_notes = 'Probe failed at ' || $3::text || '; rejected and purged.'
          WHERE id = $1`,
        [row.id, row.domain_id, `${Math.round(rate * 100)}%`]);
      decisions.push({ host: row.host, decision: 'rejected', fetched, pass_rate: round(rate) });
    }
  }

  return { evaluated: rows.length, decisions };
}

const round = (n) => Math.round(n * 1000) / 10;
