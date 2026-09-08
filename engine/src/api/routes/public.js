// Public endpoints (§14).

import { search } from '../../query/orchestrator.js';
import { ranking } from '../../config.js';
import { isAdmin } from '../auth.js';
import { normalize } from '../../text/normalize.js';
import { embeddingCacheStats } from '../../query/cache.js';

const exact = (path) => (p) => p === path;

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

export const routes = [
  {
    method: 'GET', match: exact('/api/v1/search'),
    handle: async ({ url, identity }) => {
      const q = url.searchParams.get('q') ?? '';
      if (q.length < 1 || q.length > 256) throw bad('q must be 1 to 256 characters');

      const size = clamp(int(url.searchParams.get('size'), 10), 1, 50);
      const page = Math.max(1, int(url.searchParams.get('page'), 1));

      // debug=true "requires admin right" (§14). A caller without it gets
      // results, not an error -- the flag is ignored, because failing the whole
      // search over a diagnostic parameter helps nobody.
      const debug = url.searchParams.get('debug') === 'true' && isAdmin(identity);

      const zones = csv(url.searchParams.get('zones'))
        .map((z) => z.toUpperCase()).filter((z) => z === 'A' || z === 'B');
      const tiers = csv(url.searchParams.get('tier'))
        .map((t) => t.toUpperCase()).filter((t) => t === 'T2' || t === 'T3');

      const result = await search({
        q, zones, page, size,
        rerank: url.searchParams.get('rerank') !== 'false',
        debug,
        filters: {
          lang: url.searchParams.get('lang') || null,
          site: url.searchParams.get('site') || null,
          category: url.searchParams.get('category') || null,
          persona: url.searchParams.get('persona') || null,
          tiers,
        },
        sessionId: url.searchParams.get('session') || null,
        // §14 widget mode. Ordering only -- it cannot widen a zone or admit a
        // page that retrieval did not already return.
        preferSite: url.searchParams.get('prefer_site') || null,
        // §17 privacy: the Jubilee ID is recorded only when the user is signed
        // in. Anonymous search stays anonymous; there is no device fingerprint
        // standing in for an identity.
        jubileeId: identity?.jubilee_id ?? null,
      });

      return { status: 200, body: result };
    },
  },

  {
    method: 'GET', match: exact('/api/v1/suggest'),
    handle: async ({ url, db }) => {
      const raw = url.searchParams.get('q') ?? '';
      if (raw.length < 2) return { status: 200, body: { suggestions: [] } };
      const { normalized } = normalize(raw);
      if (!normalized) return { status: 200, body: { suggestions: [] } };

      // "trigram + popular queries + entity aliases, <= 50 ms" (§14). Three
      // cheap sources unioned, ordered by how well each matches the prefix.
      //
      // Popular queries are drawn only from queries that returned something.
      // Suggesting a phrase that leads to an empty result page is worse than
      // suggesting nothing, and it is also how a typo becomes a permanent
      // fixture of the suggestion list.
      // The union is wrapped in a subquery rather than ordered directly.
      // Postgres allows only output column names or ordinals in the ORDER BY of
      // a set operation, so `ORDER BY weight DESC, length(text)` on the union
      // itself is rejected outright with "invalid UNION/INTERSECT/EXCEPT ORDER
      // BY clause". Ordering the wrapper is the same plan and is legal.
      const { rows } = await db.query(`
        SELECT text, weight FROM (
          (SELECT sq.normalized AS text, count(*) * 2 AS weight
             FROM search_queries sq
            WHERE sq.normalized LIKE $1 || '%'
              AND COALESCE(sq.zone_a_count, 0) + COALESCE(sq.zone_b_count, 0) > 0
              AND sq.created_at > now() - interval '90 days'
            GROUP BY sq.normalized
            ORDER BY count(*) DESC
            LIMIT 6)
          UNION ALL
          (SELECT a.alias AS text, 3 AS weight
             FROM entity_aliases a
             JOIN entities e ON e.id = a.entity_id AND e.active
            WHERE a.alias LIKE $1 || '%'
            LIMIT 4)
          UNION ALL
          (SELECT p.title AS text, 1 AS weight
             FROM servable_pages p
            WHERE p.tier = 'T1' AND p.title IS NOT NULL
              AND lower(p.title) % $1
            ORDER BY similarity(lower(p.title), $1) DESC
            LIMIT 4)
        ) candidates
        ORDER BY weight DESC, length(text) ASC
        LIMIT 10`, [normalized]);

      // Deduplicate case-insensitively; the three sources overlap by design.
      const seen = new Set();
      const suggestions = [];
      for (const row of rows) {
        const key = row.text?.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        suggestions.push(row.text);
      }
      return { status: 200, body: { suggestions } };
    },
  },

  {
    // Click logging (R7). Ships in Phase 3 though nothing reads it until Phase 5.
    method: 'POST', match: exact('/api/v1/event'),
    handle: async ({ body, db }) => {
      const { query_id, page_id, zone, position, type } = body.parsed ?? {};
      if (type !== 'click') throw bad("type must be 'click'");
      if (!Number.isInteger(query_id) || !Number.isInteger(page_id)) {
        throw bad('query_id and page_id must be integers');
      }
      if (zone !== 'A' && zone !== 'B') throw bad("zone must be 'A' or 'B'");
      if (!Number.isInteger(position) || position < 1) throw bad('position must be a positive integer');

      // Update the impression that was logged when the result was rendered
      // rather than inserting a click row. The pair is what the position-bias
      // correction needs: a click without its impression is unusable, because
      // there is nothing to divide by.
      const { rowCount } = await db.query(
        `UPDATE result_impressions
            SET clicked = TRUE, clicked_at = now()
          WHERE query_id = $1 AND page_id = $2 AND zone = $3 AND position = $4
            AND NOT clicked`,
        [query_id, page_id, zone, position]);

      return { status: 202, body: { recorded: rowCount === 1 } };
    },
  },

  {
    // Abuse reporting (§11.3).
    method: 'POST', match: exact('/api/v1/report'),
    handle: async ({ body, db, req }) => {
      const { url: reported, reason, note } = body.parsed ?? {};
      if (!reported || typeof reported !== 'string') throw bad('url is required');
      if (!reason || typeof reason !== 'string') throw bad('reason is required');

      const cfg = await ranking();
      const ip = req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? null;

      // The prior count is taken in a CTE and the new report added to it, rather
      // than counted after the insert. A data-modifying CTE is not visible to
      // the rest of its own statement, so counting afterwards would miss the row
      // being inserted -- and suppression would trigger on the fourth report
      // rather than the third.
      const { rows } = await db.query(
        `WITH page AS (SELECT id FROM pages WHERE url = $1 LIMIT 1),
              prior AS (
                SELECT count(*) AS n FROM abuse_reports a
                 WHERE a.page_id = (SELECT id FROM page)),
              report AS (
                INSERT INTO abuse_reports (page_id, url, reason, note, reporter_ip)
                SELECT (SELECT id FROM page), $1, $2, $3, $4::inet
                RETURNING page_id)
         SELECT report.page_id, (SELECT n FROM prior) + 1 AS reports
         FROM report`,
        [reported, reason.slice(0, 200), note ? String(note).slice(0, 2000) : null, ip]);

      const pageId = rows[0]?.page_id ?? null;
      const reports = Number(rows[0]?.reports ?? 0);

      if (pageId) {
        // "A report immediately drops the page below the fold pending review and
        // creates a safety_reviews row at top priority. Three reports on one page
        // suppress it from results automatically until a human clears it."
        await db.query(
          `INSERT INTO safety_reviews (page_id, machine_reasons, notes)
           VALUES ($1, jsonb_build_object('source','abuse_report','reason',$2::text), $3)`,
          [pageId, reason.slice(0, 200), note ? String(note).slice(0, 2000) : null]);

        if (reports >= cfg.abuse_reports_to_suppress) {
          await db.query('UPDATE pages SET suppressed = TRUE WHERE id = $1', [pageId]);
        }
      }

      // The reporter is told the report landed and nothing else. Confirming
      // whether the URL is in the index, or how many others have reported it,
      // would be a probe of the index dressed up as a form.
      return { status: 202, body: { received: true } };
    },
  },

  {
    method: 'GET', match: exact('/api/v1/health'), auth: false, rateLimit: false,
    handle: async ({ db }) => {
      const started = Date.now();
      try {
        const { rows } = await db.query(`
          SELECT
            (SELECT count(*) FROM pages WHERE status = 'indexed') AS indexed_pages,
            (SELECT count(*) FROM chunks WHERE embedded_at IS NOT NULL) AS embedded_chunks,
            (SELECT count(*) FROM chunks WHERE embedded_at IS NULL) AS embedding_backlog,
            (SELECT count(*) FROM safety_reviews WHERE reviewed_at IS NULL) AS safety_queue,
            (SELECT count(*) FROM domains WHERE status = 'active') AS active_domains,
            (SELECT count(*) FROM domains WHERE consecutive_failures >= 3) AS failing_domains,
            (SELECT version FROM index_version WHERE id) AS index_version`);
        const r = rows[0];
        return {
          status: 200,
          body: {
            status: 'ok',
            db_latency_ms: Date.now() - started,
            index: {
              indexed_pages: Number(r.indexed_pages),
              embedded_chunks: Number(r.embedded_chunks),
              embedding_backlog: Number(r.embedding_backlog),
              index_version: Number(r.index_version),
            },
            queues: { safety_review: Number(r.safety_queue) },
            domains: { active: Number(r.active_domains), failing: Number(r.failing_domains) },
            embedding_cache: embeddingCacheStats(),
          },
        };
      } catch (err) {
        return { status: 503, body: { status: 'degraded', error: err.message } };
      }
    },
  },
];

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const csv = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
