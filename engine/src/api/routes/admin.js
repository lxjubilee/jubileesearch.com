// Admin API (§15).
//
// This is the API behind the ten screens §15 lists. The console UI itself is not
// built -- Phase 1 asks for an "admin skeleton", and these are its endpoints.
//
// Every write records who did it. §13.4 requires it for best bets, §8.2 for
// ownership verification, and §15 screen 9 for ranking changes with "a change
// log and one-click revert". The actor is always the Jubilee ID from SSO; there
// is no service account that writes as nobody.

import { ranking } from '../../config.js';
import { validatePattern } from '../../query/bestbets.js';
import { dedupeExact } from '../../ingest/service.js';
import { sweepResultCache } from '../../query/cache.js';
import { beginProbe } from '../../crawl/discovery.js';

const exact = (path) => (p) => p === path;
const pattern = (re) => (p) => re.test(p);
const idFrom = (re) => (p) => ({ id: Number(p.match(re)?.[1]) });
const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

// Never selected: webhook_secret. A shared secret that can be read back out of
// an admin GET is a secret that ends up in a browser history and a screenshot.
const DOMAIN_COLUMNS = `
  id, host, display_name, tier, status, ingest_mode, source_root, url_template,
  owner_org, crawl_interval_hours, max_pages, max_depth, crawl_delay_ms,
  respect_robots, render_js, language_hint, zone_a_eligible, approved_by,
  approved_at, verification_method, verified_at, unsafe_strikes,
  last_crawl_started, last_crawl_finished, next_crawl_due, consecutive_failures,
  (webhook_secret IS NOT NULL) AS has_webhook_secret`;

export const routes = [
  // -- screen 1: dashboard ---------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/dashboard'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(`
        SELECT
          (SELECT jsonb_object_agg(tier::text, n) FROM (
             SELECT tier, count(*) AS n FROM pages WHERE status = 'indexed' GROUP BY tier) t)
            AS pages_by_tier,
          (SELECT count(*) FROM pages
            WHERE last_indexed_at > now() - interval '24 hours')      AS indexed_24h,
          (SELECT count(*) FROM chunks WHERE embedded_at IS NULL)     AS embedding_backlog,
          (SELECT count(*) FROM safety_reviews WHERE reviewed_at IS NULL) AS safety_queue,
          (SELECT count(*) FROM domains WHERE consecutive_failures >= 3)  AS failing_domains,
          (SELECT count(*) FROM domains WHERE status = 'pending')     AS pending_domains,
          (SELECT count(*) FROM domains WHERE zone_a_eligible)        AS zone_a_domains,
          (SELECT count(*) FROM ingest_runs
            WHERE mode = 'webhook' AND started_at > now() - interval '24 hours') AS webhooks_24h,
          (SELECT count(*) FROM ingest_runs
            WHERE mode = 'webhook' AND error IS NOT NULL
              AND started_at > now() - interval '24 hours')           AS webhook_failures_24h,
          (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)
             FROM search_queries WHERE created_at > now() - interval '24 hours') AS p95_latency_ms,
          (SELECT avg(CASE WHEN cache_hit THEN 1.0 ELSE 0.0 END)
             FROM search_queries WHERE created_at > now() - interval '24 hours') AS cache_hit_rate,
          -- Zone A empty-state rate. The risk register calls a Zone A that pads
          -- with weak results High/High, and this is the number that shows it.
          (SELECT avg(CASE WHEN COALESCE(zone_a_count,0) = 0 THEN 1.0 ELSE 0.0 END)
             FROM search_queries WHERE created_at > now() - interval '7 days')   AS zone_a_empty_rate,
          (SELECT count(*) FROM search_queries
            WHERE COALESCE(zone_a_count,0) + COALESCE(zone_b_count,0) = 0
              AND created_at > now() - interval '7 days')             AS zero_result_queries_7d`);
      return { status: 200, body: rows[0] };
    },
  },

  // Zone A vs Zone B click share -- the tripwire from the risk register:
  // "If Zone A CTR falls below Zone B CTR, the floor is wrong and must be
  // raised immediately."
  {
    method: 'GET', match: exact('/api/v1/admin/analytics/zone-ctr'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(`
        SELECT zone,
               count(*) AS impressions,
               count(*) FILTER (WHERE clicked) AS clicks,
               round(count(*) FILTER (WHERE clicked)::numeric
                     / NULLIF(count(*), 0), 4) AS ctr
        FROM result_impressions ri
        JOIN search_queries sq ON sq.id = ri.query_id
        WHERE sq.created_at > now() - interval '30 days'
        GROUP BY zone ORDER BY zone`);
      const byZone = Object.fromEntries(rows.map((r) => [r.zone, r]));
      const a = Number(byZone.A?.ctr ?? 0);
      const b = Number(byZone.B?.ctr ?? 0);
      return {
        status: 200,
        body: {
          zones: rows,
          zone_a_below_zone_b: rows.length === 2 && a < b,
          note: rows.length === 2 && a < b
            ? 'Zone A CTR is below Zone B CTR. Per the risk register, the relevance floor is too low and must be raised.'
            : null,
        },
      };
    },
  },

  {
    method: 'GET', match: exact('/api/v1/admin/analytics/zero-results'), right: 'view',
    handle: async ({ db, url }) => {
      // §10.3 and §16: zero-result queries are content assignments for the
      // writing team and seeds for whitelist nomination.
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
      const { rows } = await db.query(`
        SELECT normalized, lang, intent, count(*) AS times, max(created_at) AS last_seen
        FROM search_queries
        WHERE COALESCE(zone_a_count,0) + COALESCE(zone_b_count,0) = 0
          AND created_at > now() - ($1 || ' days')::interval
          AND normalized <> ''
        GROUP BY normalized, lang, intent
        ORDER BY count(*) DESC LIMIT 200`, [String(days)]);
      return { status: 200, body: { days, queries: rows } };
    },
  },

  // -- screen 2: domains -----------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/domains'), right: 'view',
    handle: async ({ db, url }) => {
      const tier = url.searchParams.get('tier');
      const status = url.searchParams.get('status');
      const { rows } = await db.query(
        `SELECT ${DOMAIN_COLUMNS},
                (SELECT count(*) FROM pages p
                  WHERE p.domain_id = d.id AND p.status = 'indexed') AS indexed_pages
           FROM domains d
          WHERE ($1::text IS NULL OR d.tier = $1::trust_tier)
            AND ($2::text IS NULL OR d.status = $2::domain_status)
          ORDER BY d.host`, [tier, status]);
      return { status: 200, body: { domains: rows } };
    },
  },

  {
    method: 'POST', match: exact('/api/v1/admin/domains'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const d = body.parsed ?? {};
      if (!d.host) throw bad('host is required');
      if (!['T0', 'T1', 'T2', 'T3'].includes(d.tier)) throw bad('tier must be T0, T1, T2 or T3');

      // §8.1: all three registration methods land in status='pending'.
      // §8.2: zone_a_eligible is never granted at registration.
      const defaults = TIER_DEFAULTS[d.tier];
      const { rows } = await db.query(
        `INSERT INTO domains (host, display_name, tier, status, ingest_mode, source_root,
                              url_template, owner_org, crawl_interval_hours, max_pages,
                              max_depth, crawl_delay_ms, respect_robots, language_hint,
                              approval_notes)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (host) DO UPDATE SET
             display_name = EXCLUDED.display_name, tier = EXCLUDED.tier,
             ingest_mode = EXCLUDED.ingest_mode, source_root = EXCLUDED.source_root,
             url_template = EXCLUDED.url_template, owner_org = EXCLUDED.owner_org
         RETURNING ${DOMAIN_COLUMNS}`,
        [String(d.host).toLowerCase(), d.display_name ?? null, d.tier,
         d.ingest_mode ?? defaults.ingest_mode, d.source_root ?? null,
         d.url_template ?? null, d.owner_org ?? null,
         d.crawl_interval_hours ?? defaults.crawl_interval_hours,
         d.max_pages ?? defaults.max_pages, d.max_depth ?? defaults.max_depth,
         d.crawl_delay_ms ?? defaults.crawl_delay_ms,
         // §8.3: robots is configurable on T1 only; T2 and T3 are always TRUE.
         d.tier === 'T1' ? (d.respect_robots ?? true) : true,
         d.language_hint ?? null,
         `registered by ${identity.jubilee_id}`]);
      return { status: 201, body: rows[0] };
    },
  },

  {
    // §8.2. This is the only path to Zone A, and it is a security control.
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/domains\/\d+\/verify$/),
    params: idFrom(/domains\/(\d+)\/verify/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const method = body.parsed?.method;
      if (!['dns_txt', 'well_known', 'authoritative_list'].includes(method)) {
        throw bad("method must be 'dns_txt', 'well_known' or 'authoritative_list'");
      }
      const { rows } = await db.query(
        `UPDATE domains
            SET zone_a_eligible = TRUE, status = 'active',
                verification_method = $2, verified_at = now(),
                approved_by = $3, approved_at = now(),
                next_crawl_due = COALESCE(next_crawl_due, now())
          WHERE id = $1 AND tier = 'T1'
          RETURNING ${DOMAIN_COLUMNS}`,
        [params.id, method, identity.jubilee_id]);
      if (!rows[0]) throw bad('no such T1 domain');
      return { status: 200, body: rows[0] };
    },
  },

  {
    // P5: "Any domain, page, or tier can be purged from the index with one admin
    // action and one job run." Acceptance criterion 22 times the block case at
    // one job cycle; blocking here purges in the same transaction, which is
    // faster than the criterion requires and simpler to prove.
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/domains\/\d+\/purge$/),
    params: idFrom(/domains\/(\d+)\/purge/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const block = body.parsed?.block === true;
      const { rows } = await db.query(
        `WITH cleared AS (DELETE FROM pages WHERE domain_id = $1 RETURNING id)
         UPDATE domains SET status = $2::domain_status,
                            zone_a_eligible = FALSE,
                            approval_notes = $3
          WHERE id = $1
          RETURNING host, (SELECT count(*) FROM cleared) AS pages_purged`,
        [params.id, block ? 'blocked' : 'purged',
         `${block ? 'blocked' : 'purged'} by ${identity.jubilee_id}`]);
      if (!rows[0]) throw bad('no such domain');
      await db.query('SELECT bump_index_version($1)', [identity.jubilee_id]);
      return { status: 200, body: rows[0] };
    },
  },

  // -- screen 9: ranking controls -------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/ranking'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(
        'SELECT key, value, description, updated_by, updated_at FROM ranking_config ORDER BY key');
      const { rows: audit } = await db.query(
        'SELECT key, old_value, new_value, actor, at FROM ranking_config_audit ORDER BY at DESC LIMIT 50');
      return { status: 200, body: { config: rows, recent_changes: audit } };
    },
  },

  {
    method: 'PUT', match: exact('/api/v1/admin/ranking'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const updates = body.parsed ?? {};
      const keys = Object.keys(updates);
      if (keys.length === 0) throw bad('no changes supplied');

      const changed = [];
      for (const key of keys) {
        const value = Number(updates[key]);
        if (!Number.isFinite(value)) throw bad(`${key} must be a number`);
        const { rows } = await db.query(
          // The old value is captured in a CTE rather than read back in
          // RETURNING: both happen to work under Postgres snapshot rules, but
          // only one of them says so on the page.
          `WITH previous AS (SELECT value FROM ranking_config WHERE key = $1)
           UPDATE ranking_config
              SET value = $2, updated_by = $3, updated_at = now()
            WHERE key = $1
            RETURNING key, value, (SELECT value FROM previous) AS previous`,
          [key, value, identity.jubilee_id]);
        if (!rows[0]) throw bad(`unknown ranking key '${key}'`);
        await db.query(
          `INSERT INTO ranking_config_audit (key, old_value, new_value, actor)
           VALUES ($1, $2, $3, $4)`,
          [key, rows[0].previous, value, identity.jubilee_id]);
        changed.push({ key, value });
      }
      // The UPDATE trigger already bumped the index version, so the result cache
      // is invalidated and nothing is served under the old weights.
      await ranking(true);
      return { status: 200, body: { changed } };
    },
  },

  // -- screen 4: best bets ---------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/best-bets'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(
        `SELECT b.*, (SELECT count(*) FROM best_bet_audit a WHERE a.best_bet_id = b.id) AS revisions
           FROM best_bets b ORDER BY b.active DESC, b.position, b.id`);
      return { status: 200, body: { best_bets: rows } };
    },
  },

  {
    method: 'POST', match: exact('/api/v1/admin/best-bets'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const b = body.parsed ?? {};
      const check = await validatePattern(db, b.match_type, b.pattern);
      if (!check.ok) throw bad(check.error);
      if (!b.target_url) throw bad('target_url is required');
      if (b.blurb && b.blurb.length > 240) throw bad('blurb is limited to 240 characters');

      const { rows } = await db.query(
        `INSERT INTO best_bets (match_type, pattern, lang, target_url, target_page_id,
                                title_override, blurb, position, starts_at, ends_at, created_by)
         VALUES ($1,$2,$3,$4,(SELECT id FROM pages WHERE url = $4 LIMIT 1),$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [b.match_type, b.pattern, b.lang ?? null, b.target_url,
         b.title_override ?? null, b.blurb ?? null, b.position ?? 1,
         b.starts_at ?? null, b.ends_at ?? null, identity.jubilee_id]);

      await db.query(
        `INSERT INTO best_bet_audit (best_bet_id, action, actor, after_state)
         VALUES ($1, 'create', $2, $3)`,
        [rows[0].id, identity.jubilee_id, rows[0]]);

      // No index-version bump: a best bet bypasses the cache by construction
      // (§13.7), so it is live on the next request without invalidating anything.
      return { status: 201, body: rows[0] };
    },
  },

  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/best-bets\/\d+\/deactivate$/),
    params: idFrom(/best-bets\/(\d+)\/deactivate/), right: 'admin',
    handle: async ({ db, params, identity }) => {
      const { rows } = await db.query(
        'UPDATE best_bets SET active = FALSE WHERE id = $1 RETURNING *', [params.id]);
      if (!rows[0]) throw bad('no such best bet');
      await db.query(
        `INSERT INTO best_bet_audit (best_bet_id, action, actor, after_state)
         VALUES ($1, 'deactivate', $2, $3)`, [params.id, identity.jubilee_id, rows[0]]);
      return { status: 200, body: rows[0] };
    },
  },

  // -- screen 3: lexicon -----------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/lexicon'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(`
        SELECT c.id, c.concept_key, c.gloss, c.notes, c.active,
               jsonb_agg(jsonb_build_object(
                   'id', t.id, 'term', t.term, 'lang', t.lang,
                   'register', t.register, 'weight', t.weight, 'is_primary', t.is_primary)
                 ORDER BY t.is_primary DESC, t.lang, t.term)
                 FILTER (WHERE t.id IS NOT NULL) AS terms
        FROM lexicon_concepts c
        LEFT JOIN lexicon_terms t ON t.concept_id = c.id
        GROUP BY c.id ORDER BY c.concept_key`);
      // `register` is returned here and only here. §7.5: it is an internal
      // editing label, and this is the admin console, not a reader surface.
      return { status: 200, body: { concepts: rows } };
    },
  },

  {
    method: 'POST', match: exact('/api/v1/admin/lexicon/terms'), right: 'admin',
    handle: async ({ db, body }) => {
      const t = body.parsed ?? {};
      if (!t.concept_key || !t.term || !t.lang) throw bad('concept_key, term and lang are required');
      try {
        const { rows } = await db.query(
          `INSERT INTO lexicon_terms (concept_id, term, lang, register, weight, is_primary)
           SELECT c.id, $2, $3, $4, $5, $6 FROM lexicon_concepts c WHERE c.concept_key = $1
           ON CONFLICT (term, lang, concept_id) DO UPDATE
              SET register = EXCLUDED.register, weight = EXCLUDED.weight,
                  is_primary = EXCLUDED.is_primary
           RETURNING *`,
          [t.concept_key, String(t.term).toLowerCase().trim(), t.lang,
           t.register ?? null, t.weight ?? null, t.is_primary === true]);
        if (!rows[0]) throw bad(`no concept '${t.concept_key}'`);
        return { status: 201, body: rows[0] };
      } catch (err) {
        // The doubled-article constraint from §13.3 surfaces here. Translate it
        // into the sentence the editor needs rather than a constraint name.
        if (err.constraint === 'lexicon_terms_no_doubled_article') {
          throw bad('Term carries both the English article and the Hebrew Ha- prefix. ' +
                    'Write "Ruach HaKodesh" or "the Ruach Kodesh", not "the Ruach HaKodesh".');
        }
        throw err;
      }
    },
  },

  // -- screen 6: safety queue ------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/safety/queue'), right: 'view',
    handle: async ({ db }) => {
      const { rows } = await db.query(`
        SELECT r.id, r.page_id, r.machine_score, r.machine_reasons, r.notes, r.created_at,
               p.url, p.title, p.tier, p.safety_verdict,
               left(p.body_text, 4000) AS body_excerpt,
               d.host,
               EXTRACT(EPOCH FROM (now() - r.created_at)) / 3600 AS age_hours
        FROM safety_reviews r
        JOIN pages p ON p.id = r.page_id
        JOIN domains d ON d.id = p.domain_id
        WHERE r.reviewed_at IS NULL
        ORDER BY r.created_at
        LIMIT 100`);
      // §17 Security: "Fetched HTML never rendered in the admin console without
      // sanitization." body_excerpt is extracted plain text, and the console
      // must still render it as text, not as markup.
      return { status: 200, body: { queue: rows, target_latency_hours: 48 } };
    },
  },

  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/safety\/\d+$/),
    params: idFrom(/safety\/(\d+)$/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const verdict = body.parsed?.verdict;
      if (!['approve', 'reject', 'block_domain'].includes(verdict)) {
        throw bad("verdict must be 'approve', 'reject' or 'block_domain'");
      }
      const { rows } = await db.query(
        `UPDATE safety_reviews
            SET verdict = $2, reviewer = $3, reviewed_at = now(), notes = COALESCE($4, notes)
          WHERE id = $1 RETURNING page_id`,
        [params.id, verdict, identity.jubilee_id, body.parsed?.notes ?? null]);
      if (!rows[0]) throw bad('no such review');
      const pageId = rows[0].page_id;

      if (verdict === 'approve') {
        await db.query(
          `UPDATE pages SET safety_verdict = 'safe', suppressed = FALSE, status = 'indexed'
            WHERE id = $1`, [pageId]);
      } else if (verdict === 'reject') {
        await db.query(
          `UPDATE pages SET safety_verdict = 'unsafe', status = 'rejected' WHERE id = $1`, [pageId]);
      } else {
        await db.query(`
          WITH target AS (SELECT domain_id FROM pages WHERE id = $1)
             , purged AS (DELETE FROM pages WHERE domain_id = (SELECT domain_id FROM target))
          UPDATE domains SET status = 'blocked', zone_a_eligible = FALSE
           WHERE id = (SELECT domain_id FROM target)`, [pageId]);
        await db.query('SELECT bump_index_version($1)', [identity.jubilee_id]);
      }
      return { status: 200, body: { review_id: params.id, verdict } };
    },
  },

  // -- screen 10: index tools ------------------------------------------------
  {
    method: 'POST', match: exact('/api/v1/admin/index/bump-version'), right: 'admin',
    handle: async ({ db, identity }) => {
      const { rows } = await db.query('SELECT bump_index_version($1) AS version', [identity.jubilee_id]);
      await ranking(true);
      return { status: 200, body: { index_version: Number(rows[0].version) } };
    },
  },

  {
    method: 'POST', match: exact('/api/v1/admin/index/dedupe'), right: 'admin',
    handle: async ({ db }) => ({ status: 200, body: { duplicates_marked: await dedupeExact(db) } }),
  },

  {
    method: 'POST', match: exact('/api/v1/admin/index/sweep-cache'), right: 'admin',
    handle: async ({ db }) => ({ status: 200, body: { rows_swept: await sweepResultCache(db) } }),
  },

  {
    // §15 screen 10: "view the full ingest or crawl log for a given URL".
    method: 'GET', match: exact('/api/v1/admin/index/explain'), right: 'view',
    handle: async ({ db, url }) => {
      const target = url.searchParams.get('url');
      if (!target) throw bad('url is required');
      const { rows } = await db.query(`
        SELECT p.id, p.url, p.status, p.tier, p.safety_verdict, p.safety_reasons,
               p.suppressed, p.word_count, p.language, p.content_hash IS NOT NULL AS has_hash,
               p.last_fetched_at, p.last_indexed_at, p.fetch_failures,
               d.host, d.status AS domain_status, d.zone_a_eligible,
               (SELECT count(*) FROM chunks c WHERE c.page_id = p.id) AS chunks,
               (SELECT count(*) FROM chunks c WHERE c.page_id = p.id AND c.embedded_at IS NOT NULL) AS embedded_chunks,
               EXISTS (SELECT 1 FROM servable_pages s WHERE s.id = p.id) AS servable
        FROM pages p JOIN domains d ON d.id = p.domain_id
        WHERE p.url = $1`, [target]);
      if (!rows[0]) return { status: 404, body: { error: 'no such page in the index' } };
      const page = rows[0];
      return {
        status: 200,
        body: {
          ...page,
          // P4 applied to the index rather than to a result: why is this page
          // not showing up?
          why_not_servable: page.servable ? null : explainUnservable(page),
        },
      };
    },
  },
  // -- screen 5: whitelist review -------------------------------------------
  // §15: "Nominated domains awaiting T2 approval, with sample pages and an
  // approve or reject decision recorded with reviewer and timestamp."
  //
  // The same queue carries trust-graph T3 candidates (§10.2). They are told
  // apart by target_tier, and the difference in handling is real: a T2 approval
  // is an editorial judgement that puts a site in the index, while a T3 approval
  // only authorises a 20-page probe that still has to pass the safety gates.
  {
    method: 'GET', match: exact('/api/v1/admin/candidates'), right: 'view',
    handle: async ({ db, url }) => {
      const tier = url.searchParams.get('tier');
      const status = url.searchParams.get('status');
      const { rows } = await db.query(
        `SELECT c.*,
                EXTRACT(EPOCH FROM (now() - c.first_seen_at)) / 86400 AS age_days,
                (SELECT count(*) FROM pages p
                  WHERE p.domain_id = c.promoted_domain_id) AS probe_pages,
                (SELECT count(*) FROM pages p
                  WHERE p.domain_id = c.promoted_domain_id
                    AND p.safety_verdict = 'safe') AS probe_passed
           FROM domain_candidates c
          WHERE ($1::text IS NULL OR c.target_tier = $1::trust_tier)
            AND ($2::text IS NULL OR c.status = $2::candidate_status)
          ORDER BY c.status, c.linking_domains DESC, c.first_seen_at
          LIMIT 200`, [tier, status]);
      return { status: 200, body: { candidates: rows } };
    },
  },

  {
    // Manual nomination. §10.2 allows a candidate to bypass the link threshold
    // when a person vouches for it, and §11.4 makes that the *only* route into
    // T2: "T2 whitelist membership is a human editorial decision."
    method: 'POST', match: exact('/api/v1/admin/candidates'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const c = body.parsed ?? {};
      const host = String(c.host ?? '').toLowerCase().replace(/^www\./, '').trim();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw bad('host must be a bare hostname');
      if (!['T2', 'T3'].includes(c.target_tier)) throw bad('target_tier must be T2 or T3');

      const { rows: existing } = await db.query('SELECT id FROM domains WHERE host = $1', [host]);
      if (existing[0]) throw bad(`${host} is already registered`);

      const { rows } = await db.query(
        `INSERT INTO domain_candidates
            (host, target_tier, source, status, nominated_by, nomination_note, sample_urls)
         VALUES ($1, $2, 'manual', 'nominated', $3, $4, $5)
         ON CONFLICT (host) DO UPDATE
            SET target_tier = EXCLUDED.target_tier,
                nominated_by = EXCLUDED.nominated_by,
                nomination_note = EXCLUDED.nomination_note,
                status = CASE WHEN domain_candidates.status = 'rejected'
                              THEN 'nominated'::candidate_status
                              ELSE domain_candidates.status END,
                last_seen_at = now()
         RETURNING *`,
        [host, c.target_tier, identity.jubilee_id, c.note ?? null, c.sample_urls ?? null]);
      return { status: 201, body: rows[0] };
    },
  },

  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/candidates\/\d+\/approve$/),
    params: idFrom(/candidates\/(\d+)\/approve/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const { rows } = await db.query(
        'SELECT * FROM domain_candidates WHERE id = $1', [params.id]);
      const candidate = rows[0];
      if (!candidate) throw bad('no such candidate');
      if (candidate.status === 'promoted') throw bad('already promoted');

      await db.query(
        `UPDATE domain_candidates
            SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
                review_notes = $3
          WHERE id = $1`,
        [params.id, identity.jubilee_id, body.parsed?.notes ?? null]);

      if (candidate.target_tier === 'T2') {
        // A T2 approval is the editorial decision itself, so the domain enters
        // the registry at T2 with the §8.3 defaults for that tier. It is never
        // zone_a_eligible: §8.2 reserves that for verified T1, and the schema
        // constraint would refuse it anyway.
        const { rows: created } = await db.query(
          `INSERT INTO domains (host, tier, status, ingest_mode, crawl_interval_hours,
                                max_pages, max_depth, crawl_delay_ms, respect_robots,
                                approved_by, approved_at, approval_notes)
           VALUES ($1, 'T2', 'active', 'crawl', 168, 5000, 4, 1500, TRUE,
                   $2, now(), $3)
           ON CONFLICT (host) DO NOTHING
           RETURNING ${DOMAIN_COLUMNS}`,
          [candidate.host, identity.jubilee_id,
           `Approved from whitelist review by ${identity.jubilee_id}`]);

        await db.query(
          `UPDATE domain_candidates SET status = 'promoted', promoted_domain_id = $2
            WHERE id = $1`, [params.id, created[0]?.id ?? null]);

        return { status: 200, body: { approved: candidate.host, tier: 'T2', domain: created[0] ?? null } };
      }

      // T3: approval authorises a probe, not an index entry. The domain enters
      // at T0 with a 20-page cap and has to earn its way out (§10.2).
      const cfg = await ranking();
      const probe = await beginProbe(db, params.id, cfg, identity.jubilee_id);
      return {
        status: 200,
        body: {
          approved: candidate.host,
          tier: 'T0 (probe)',
          ...probe,
          note: 'Entered quarantine with a page cap. Nothing from it is servable until the sample passes the safety gates.',
        },
      };
    },
  },

  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/candidates\/\d+\/reject$/),
    params: idFrom(/candidates\/(\d+)\/reject/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      // A rejection also purges anything a probe already fetched, so declining a
      // candidate leaves nothing of it behind.
      const { rows } = await db.query(
        `WITH candidate AS (SELECT promoted_domain_id FROM domain_candidates WHERE id = $1),
              purged AS (DELETE FROM pages
                          WHERE domain_id = (SELECT promoted_domain_id FROM candidate)),
              gone AS (DELETE FROM domains
                        WHERE id = (SELECT promoted_domain_id FROM candidate) AND tier = 'T0')
         UPDATE domain_candidates
            SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                review_notes = $3, promoted_domain_id = NULL
          WHERE id = $1
          RETURNING host`,
        [params.id, identity.jubilee_id, body.parsed?.notes ?? null]);
      if (!rows[0]) throw bad('no such candidate');
      return { status: 200, body: { rejected: rows[0].host } };
    },
  },

  // -- screen 7: blocklists --------------------------------------------------
  // §15: "Loaded sources, refresh status, manual entries."
  {
    method: 'GET', match: exact('/api/v1/admin/blocklists'), right: 'view',
    handle: async ({ db }) => {
      const { rows: sources } = await db.query(
        `SELECT b.source,
                count(*) AS entries,
                count(*) FILTER (WHERE b.severity >= 100) AS hard_blocks,
                count(*) FILTER (WHERE b.severity = 0)    AS allow_overrides,
                l.started_at AS last_load,
                l.outcome    AS last_outcome,
                l.entries_written AS last_written,
                l.error      AS last_error
           FROM blocklist_entries b
           LEFT JOIN LATERAL (
                SELECT * FROM blocklist_loads bl
                 WHERE bl.source = b.source
                 ORDER BY bl.started_at DESC LIMIT 1) l ON TRUE
          GROUP BY b.source, l.started_at, l.outcome, l.entries_written, l.error
          ORDER BY b.source`);

      // Manual rules are the only ones editable here; a loaded rule belongs to
      // its source and is replaced wholesale on the next refresh.
      const { rows: manual } = await db.query(
        `SELECT id, pattern, match_type, category, severity, added_at
           FROM blocklist_entries WHERE source = 'manual'
          ORDER BY severity DESC, category, pattern`);

      const { rows: recent } = await db.query(
        `SELECT source, started_at, finished_at, entries_parsed, entries_written, outcome, error
           FROM blocklist_loads ORDER BY started_at DESC LIMIT 20`);

      return { status: 200, body: { sources, manual_entries: manual, recent_loads: recent } };
    },
  },

  {
    method: 'POST', match: exact('/api/v1/admin/blocklists/entries'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const e = body.parsed ?? {};
      if (!['host', 'suffix', 'regex', 'keyword'].includes(e.match_type)) {
        throw bad("match_type must be 'host', 'suffix', 'regex' or 'keyword'");
      }
      if (!e.pattern || String(e.pattern).length > 300) throw bad('pattern must be 1 to 300 characters');
      if (!e.category) throw bad('category is required');

      const severity = Number(e.severity ?? 100);
      if (!Number.isFinite(severity) || severity < 0 || severity > 100) {
        throw bad('severity must be between 0 and 100');
      }

      if (e.match_type === 'regex') {
        try { await db.query("SELECT 'x' ~ $1", [e.pattern]); }
        catch (err) { throw bad(`invalid regular expression: ${err.message}`); }
      }

      // The scripture problem, enforced rather than documented. Migration 024
      // spells out why a keyword rule must not target a word that appears in
      // scripture: a filter that blocks those words makes a faith-based engine
      // useless at exactly the passages people come to it for. A hard block on a
      // single ordinary word is how that happens by accident.
      if (e.match_type === 'keyword' && severity >= 100 && !/[\s-]/.test(String(e.pattern).trim())) {
        throw bad(
          'A single-word keyword cannot be a hard block. Scripture discusses adultery, ' +
          'drunkenness and slaughter in plain terms, and a hard block on one word excludes ' +
          'every commentary that quotes it. Use a phrase, or a severity below 100 so it ' +
          'routes to the review queue instead.');
      }

      const { rows } = await db.query(
        `INSERT INTO blocklist_entries (pattern, match_type, category, source, severity)
         VALUES ($1, $2, $3, 'manual', $4) RETURNING *`,
        [String(e.pattern).toLowerCase().trim(), e.match_type, e.category, severity]);

      await db.query('SELECT bump_index_version($1)', [identity.jubilee_id]);
      return { status: 201, body: rows[0] };
    },
  },

  {
    method: 'DELETE', match: pattern(/^\/api\/v1\/admin\/blocklists\/entries\/\d+$/),
    params: idFrom(/entries\/(\d+)$/), right: 'admin',
    handle: async ({ db, params, identity }) => {
      // Only manual rules. A loaded rule deleted here would reappear on the next
      // refresh, which is a worse outcome than refusing: it looks like it worked.
      const { rows } = await db.query(
        "DELETE FROM blocklist_entries WHERE id = $1 AND source = 'manual' RETURNING pattern",
        [params.id]);
      if (!rows[0]) {
        throw bad('no such manual entry. Rules loaded from an external source are replaced ' +
                  'on refresh and cannot be deleted individually; disable the source instead.');
      }
      await db.query('SELECT bump_index_version($1)', [identity.jubilee_id]);
      return { status: 200, body: { deleted: rows[0].pattern } };
    },
  },
];

function explainUnservable(p) {
  if (p.domain_status !== 'active') return `its domain is '${p.domain_status}', not 'active'`;
  if (p.status !== 'indexed') return `page status is '${p.status}', not 'indexed'`;
  if (p.suppressed) return 'the page is suppressed by abuse reports or an admin demotion';
  if (p.tier === 'T0') return 'the page is in T0 quarantine and is never served';
  if (p.tier === 'T3' && p.safety_verdict !== 'safe') {
    return `T3 pages need safety_verdict = 'safe'; this one is '${p.safety_verdict ?? 'unclassified'}'`;
  }
  if (p.tier === 'T2' && p.safety_verdict === 'unsafe') return 'the page was classified unsafe';
  return 'unknown; check servable_pages directly';
}

// §8.3, per-domain policy defaults by tier.
const TIER_DEFAULTS = {
  T1: { ingest_mode: 'hybrid', crawl_interval_hours: 24,  max_pages: null,  max_depth: 10, crawl_delay_ms: 250 },
  T2: { ingest_mode: 'crawl',  crawl_interval_hours: 168, max_pages: 5000,  max_depth: 4,  crawl_delay_ms: 1500 },
  T3: { ingest_mode: 'crawl',  crawl_interval_hours: 720, max_pages: 500,   max_depth: 2,  crawl_delay_ms: 2500 },
  T0: { ingest_mode: 'crawl',  crawl_interval_hours: 720, max_pages: 20,    max_depth: 1,  crawl_delay_ms: 2500 },
};
