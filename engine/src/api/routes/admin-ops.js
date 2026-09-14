// Admin console endpoints that the first cut of routes/admin.js left out (§15).
//
// Every screen in the console had a footnote reading "not yet on this screen:
// ... the API does not expose it". This module is those endpoints. It is a
// sibling of admin.js rather than an extension of it only to keep each file
// readable; the guard is identical -- `right: 'admin'` for anything that
// writes, `right: 'view'` for anything that reads -- and server.js enforces it
// before a handler runs.
//
//   Domains      PUT  /domains/:id              edit a registration in place
//                POST /domains/:id/pause         pause or resume
//                POST /domains/:id/reingest      force a full re-ingest
//                POST /domains/import            bulk import (CSV or JSON rows)
//                POST /domains/:id/verification-token   issue the §8.2 token
//   Best bets    PUT  /best-bets/:id             update, including schedule
//                POST /best-bets/reorder         set positions from an ordered list
//                GET  /best-bets/audit           the full audit log
//   Lexicon      GET  /lexicon/preview?q=        how a sample query expands
//                POST /lexicon/import            bulk import of concepts and terms
//   Index tools  POST /index/reindex             reindex one page or a domain
//                POST /index/purge-page          purge one page
//                POST /index/reembed             re-embed one page or a domain
//                GET  /index/log?url=            the ingest and crawl history of a URL
//   Analytics    GET  /analytics/overview        volume by intent and language,
//                                                 CTR by zone and position, concept hits,
//                                                 top queries

import { DOMAIN_COLUMNS, TIER_DEFAULTS } from './admin.js';
import { validatePattern } from '../../query/bestbets.js';
import { expand } from '../../query/lexicon.js';
import { normalize, detectLanguage } from '../../text/normalize.js';
import { ranking } from '../../config.js';
import { enqueue } from '../../crawl/frontier.js';
import { newToken } from '../../crawl/verification.js';

const exact = (path) => (p) => p === path;
const pattern = (re) => (p) => re.test(p);
const idFrom = (re) => (p) => ({ id: Number(p.match(re)?.[1]) });
const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const INGEST_MODES = ['source_md', 'crawl', 'hybrid'];

// The columns an operator may edit in place. Everything else on `domains` is
// either state the jobs own (crawl timestamps, failure counts) or a security
// fact set only by verification (zone_a_eligible, verification_*).
const EDITABLE = {
  display_name: 'text', tier: 'tier', ingest_mode: 'ingest_mode', source_root: 'text',
  url_template: 'text', owner_org: 'text', crawl_interval_hours: 'int', max_pages: 'int',
  max_depth: 'int', crawl_delay_ms: 'int', respect_robots: 'bool', render_js: 'bool',
  language_hint: 'text', sitemap_urls: 'text[]', allow_patterns: 'text[]', deny_patterns: 'text[]',
};

function coerce(kind, value, key) {
  if (value === null || value === undefined || value === '') return null;
  switch (kind) {
    case 'text': return String(value);
    case 'int': {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) throw bad(`${key} must be a non-negative integer`);
      return n;
    }
    case 'bool': return value === true || value === 'true';
    case 'tier': if (!TIERS.includes(value)) throw bad('tier must be T0, T1, T2 or T3'); return value;
    case 'ingest_mode': if (!INGEST_MODES.includes(value)) throw bad('ingest_mode must be source_md, crawl or hybrid'); return value;
    case 'text[]': return Array.isArray(value) ? value.map(String) : String(value).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    default: return value;
  }
}

/** Parse a CSV or a JSON array into rows of plain objects. */
export function parseRows(input) {
  if (Array.isArray(input)) return input;
  const text = String(input ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw bad('JSON must be an array of objects');
    return parsed;
  }
  // CSV with a header row. Quoted fields with commas are honoured; nothing
  // fancier, because the source is a spreadsheet export.
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

async function insertDomain(db, d, actor) {
  if (!d.host) throw bad('host is required');
  if (!TIERS.includes(d.tier)) throw bad('tier must be T0, T1, T2 or T3');
  const defaults = TIER_DEFAULTS[d.tier];
  const { rows } = await db.query(
    `INSERT INTO domains (host, display_name, tier, status, ingest_mode, source_root,
                          url_template, owner_org, crawl_interval_hours, max_pages,
                          max_depth, crawl_delay_ms, respect_robots, language_hint,
                          approval_notes)
     VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (host) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, domains.display_name),
         tier = EXCLUDED.tier,
         ingest_mode = EXCLUDED.ingest_mode,
         source_root = COALESCE(EXCLUDED.source_root, domains.source_root),
         url_template = COALESCE(EXCLUDED.url_template, domains.url_template),
         owner_org = COALESCE(EXCLUDED.owner_org, domains.owner_org),
         updated_at = now()
     RETURNING ${DOMAIN_COLUMNS}, (xmax = 0) AS inserted`,
    [String(d.host).toLowerCase().trim(), d.display_name || null, d.tier,
     INGEST_MODES.includes(d.ingest_mode) ? d.ingest_mode : defaults.ingest_mode,
     d.source_root || null, d.url_template || null, d.owner_org || null,
     coerce('int', d.crawl_interval_hours, 'crawl_interval_hours') ?? defaults.crawl_interval_hours,
     coerce('int', d.max_pages, 'max_pages') ?? defaults.max_pages,
     coerce('int', d.max_depth, 'max_depth') ?? defaults.max_depth,
     coerce('int', d.crawl_delay_ms, 'crawl_delay_ms') ?? defaults.crawl_delay_ms,
     d.tier === 'T1' ? (coerce('bool', d.respect_robots) ?? true) : true,
     d.language_hint || null,
     `registered by ${actor}`]);
  return rows[0];
}

/** Reset the change detection on a set of pages so the next ingest rewrites them. */
async function forgetHashes(db, where, params) {
  const { rowCount } = await db.query(
    `UPDATE pages SET content_hash = NULL, etag = NULL, last_modified_http = NULL
      WHERE ${where}`, params);
  return rowCount;
}

/**
 * Make a domain's next run happen now. For a crawl domain the known pages are
 * also queued at manual priority, so a reindex does not wait for the sitemap
 * walk to rediscover them.
 */
async function scheduleDomain(db, domain, { urls = null } = {}) {
  await db.query(
    `UPDATE domains SET next_crawl_due = now(), updated_at = now() WHERE id = $1`, [domain.id]);
  let queued = 0;
  if (['crawl', 'hybrid'].includes(domain.ingest_mode)) {
    const list = urls ?? (await db.query(
      `SELECT url FROM pages WHERE domain_id = $1 AND status <> 'gone' ORDER BY id LIMIT 5000`,
      [domain.id])).rows.map((r) => r.url);
    if (list.length) {
      const r = await enqueue(db, list, domain, { source: 'manual', priority: 10 });
      queued = r.queued;
    }
  }
  return queued;
}

async function domainById(db, id) {
  const { rows } = await db.query(`SELECT * FROM domains WHERE id = $1`, [id]);
  if (!rows[0]) throw bad('no such domain');
  return rows[0];
}

async function pageByUrl(db, url) {
  const { rows } = await db.query(
    `SELECT p.id, p.url, p.domain_id, d.host, d.ingest_mode
       FROM pages p JOIN domains d ON d.id = p.domain_id WHERE p.url = $1`, [url]);
  return rows[0] ?? null;
}

async function domainByHost(db, host) {
  const { rows } = await db.query(`SELECT * FROM domains WHERE host = $1`, [String(host).toLowerCase()]);
  return rows[0] ?? null;
}

export const routes = [
  // -- screen 2: domains ------------------------------------------------------
  {
    method: 'PUT', match: pattern(/^\/api\/v1\/admin\/domains\/\d+$/),
    params: idFrom(/domains\/(\d+)$/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const patch = body.parsed ?? {};
      const sets = [];
      const values = [params.id];
      for (const [key, kind] of Object.entries(EDITABLE)) {
        if (!(key in patch)) continue;
        values.push(coerce(kind, patch[key], key));
        sets.push(`${key} = $${values.length}`);
      }
      if (sets.length === 0) throw bad('nothing to change');
      // §8.3: robots is configurable on T1 only. §8.2: a domain that leaves T1
      // leaves Zone A with it, whatever it was before.
      if ('tier' in patch && patch.tier !== 'T1') {
        sets.push('zone_a_eligible = FALSE', 'respect_robots = TRUE');
      }
      values.push(`edited by ${identity.jubilee_id}`);
      sets.push(`approval_notes = $${values.length}`, 'updated_at = now()');
      const { rows } = await db.query(
        `UPDATE domains SET ${sets.join(', ')} WHERE id = $1 RETURNING ${DOMAIN_COLUMNS}`, values);
      if (!rows[0]) throw bad('no such domain');
      return { status: 200, body: rows[0] };
    },
  },
  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/domains\/\d+\/pause$/),
    params: idFrom(/domains\/(\d+)\/pause/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const paused = body.parsed?.paused !== false;
      const { rows } = await db.query(
        `UPDATE domains
            SET status = $2::domain_status, approval_notes = $3, updated_at = now()
          WHERE id = $1 AND status IN ('active', 'paused', 'pending')
          RETURNING ${DOMAIN_COLUMNS}`,
        [params.id, paused ? 'paused' : 'active',
         `${paused ? 'paused' : 'resumed'} by ${identity.jubilee_id}`]);
      if (!rows[0]) throw bad('no such domain, or it is blocked or purged');
      return { status: 200, body: rows[0] };
    },
  },
  {
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/domains\/\d+\/reingest$/),
    params: idFrom(/domains\/(\d+)\/reingest/), right: 'admin',
    handle: async ({ db, params }) => {
      const domain = await domainById(db, params.id);
      const forgotten = await forgetHashes(db, 'domain_id = $1', [domain.id]);
      const queued = await scheduleDomain(db, domain);
      return { status: 200, body: { host: domain.host, pages_reset: forgotten, queued } };
    },
  },
  {
    method: 'POST', match: exact('/api/v1/admin/domains/import'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const rows = parseRows(body.parsed?.rows ?? body.parsed?.csv ?? body.parsed?.domains);
      if (rows.length === 0) throw bad('no rows to import');
      if (rows.length > 2000) throw bad('import at most 2000 domains at a time');
      const results = [];
      for (const row of rows) {
        try {
          const d = await insertDomain(db, row, identity.jubilee_id);
          results.push({ host: d.host, ok: true, inserted: d.inserted === true });
        } catch (err) {
          results.push({ host: row.host ?? '(no host)', ok: false, error: err.message });
        }
      }
      return {
        status: 200,
        body: {
          total: rows.length,
          inserted: results.filter((r) => r.ok && r.inserted).length,
          updated: results.filter((r) => r.ok && !r.inserted).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        },
      };
    },
  },
  {
    // §8.2: issue (or reissue) the token the owner publishes. Reissuing
    // invalidates the previous one, which is the point of reissuing.
    method: 'POST', match: pattern(/^\/api\/v1\/admin\/domains\/\d+\/verification-token$/),
    params: idFrom(/domains\/(\d+)\/verification-token/), right: 'admin',
    handle: async ({ db, params }) => {
      const token = newToken();
      const { rows } = await db.query(
        `UPDATE domains SET verification_token = $2, updated_at = now()
          WHERE id = $1 AND tier = 'T1' RETURNING host`, [params.id, token]);
      if (!rows[0]) throw bad('no such T1 domain');
      return {
        status: 200,
        body: {
          host: rows[0].host,
          token,
          dns_txt: `jubilee-search-verification=${token}`,
          well_known_url: `https://${rows[0].host}/.well-known/jubilee-search-${token}.txt`,
        },
      };
    },
  },

  // -- screen 4: best bets ----------------------------------------------------
  {
    method: 'PUT', match: pattern(/^\/api\/v1\/admin\/best-bets\/\d+$/),
    params: idFrom(/best-bets\/(\d+)$/), right: 'admin',
    handle: async ({ db, params, body, identity }) => {
      const b = body.parsed ?? {};
      const { rows: before } = await db.query('SELECT * FROM best_bets WHERE id = $1', [params.id]);
      if (!before[0]) throw bad('no such best bet');
      const prior = before[0];
      const matchType = b.match_type ?? prior.match_type;
      const pat = b.pattern ?? prior.pattern;
      if ('match_type' in b || 'pattern' in b) {
        const check = await validatePattern(db, matchType, pat);
        if (!check.ok) throw bad(check.error);
      }
      if (b.blurb && b.blurb.length > 240) throw bad('blurb is limited to 240 characters');
      const starts = 'starts_at' in b ? (b.starts_at || null) : prior.starts_at;
      const ends = 'ends_at' in b ? (b.ends_at || null) : prior.ends_at;
      if (starts && ends && new Date(starts) >= new Date(ends)) throw bad('starts_at must be before ends_at');
      const { rows } = await db.query(
        `UPDATE best_bets
            SET match_type = $2, pattern = $3, lang = $4, target_url = $5,
                target_page_id = (SELECT id FROM pages WHERE url = $5 LIMIT 1),
                title_override = $6, blurb = $7, position = $8,
                starts_at = $9, ends_at = $10, active = $11
          WHERE id = $1 RETURNING *`,
        [params.id, matchType, pat,
         'lang' in b ? (b.lang || null) : prior.lang,
         b.target_url ?? prior.target_url,
         'title_override' in b ? (b.title_override || null) : prior.title_override,
         'blurb' in b ? (b.blurb || null) : prior.blurb,
         b.position != null ? Number(b.position) : prior.position,
         starts, ends,
         'active' in b ? b.active === true || b.active === 'true' : prior.active]);
      await db.query(
        `INSERT INTO best_bet_audit (best_bet_id, action, actor, before_state, after_state)
         VALUES ($1, 'update', $2, $3, $4)`,
        [params.id, identity.jubilee_id, prior, rows[0]]);
      return { status: 200, body: rows[0] };
    },
  },
  {
    // { order: [id, id, ...] } -> positions 1..n in that order. Ids not listed
    // keep their positions.
    method: 'POST', match: exact('/api/v1/admin/best-bets/reorder'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const order = Array.isArray(body.parsed?.order) ? body.parsed.order.map(Number) : [];
      if (order.length === 0 || order.some((n) => !Number.isInteger(n))) throw bad('order must be a list of ids');
      const { rows: before } = await db.query(
        'SELECT * FROM best_bets WHERE id = ANY($1::bigint[])', [order]);
      const { rows } = await db.query(
        `UPDATE best_bets b SET position = o.pos
           FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, pos)
          WHERE b.id = o.id RETURNING b.*`, [order]);
      for (const after of rows) {
        const prior = before.find((p) => Number(p.id) === Number(after.id));
        if (prior && Number(prior.position) !== Number(after.position)) {
          await db.query(
            `INSERT INTO best_bet_audit (best_bet_id, action, actor, before_state, after_state)
             VALUES ($1, 'update', $2, $3, $4)`, [after.id, identity.jubilee_id, prior, after]);
        }
      }
      return { status: 200, body: { reordered: rows.length } };
    },
  },
  {
    method: 'GET', match: exact('/api/v1/admin/best-bets/audit'), right: 'view',
    handle: async ({ db, url }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
      const id = url.searchParams.get('id');
      const { rows } = await db.query(
        `SELECT id, best_bet_id, action, actor, before_state, after_state, at
           FROM best_bet_audit
          WHERE ($2::bigint IS NULL OR best_bet_id = $2)
          ORDER BY at DESC LIMIT $1`, [limit, id ? Number(id) : null]);
      return { status: 200, body: { entries: rows } };
    },
  },

  // -- screen 3: lexicon ------------------------------------------------------
  {
    // The live preview: exactly what the query pipeline does, without the search.
    method: 'GET', match: exact('/api/v1/admin/lexicon/preview'), right: 'view',
    handle: async ({ db, url }) => {
      const raw = url.searchParams.get('q') ?? '';
      if (!raw.trim()) throw bad('q is required');
      const q = normalize(raw);
      const lang = url.searchParams.get('lang') || detectLanguage(q.normalized, null);
      const cfg = await ranking();
      const expansion = await expand(db, q.normalized, lang, cfg);
      return {
        status: 200,
        body: {
          query: raw, normalized: q.normalized, lang,
          concepts: expansion.conceptKeys,
          groups: expansion.groups,
        },
      };
    },
  },
  {
    // Rows of { concept_key, gloss?, term, lang, register?, weight?, is_primary? },
    // as JSON or CSV. Concepts are created on first sight; terms upsert.
    method: 'POST', match: exact('/api/v1/admin/lexicon/import'), right: 'admin',
    handle: async ({ db, body }) => {
      const rows = parseRows(body.parsed?.rows ?? body.parsed?.csv ?? body.parsed?.terms);
      if (rows.length === 0) throw bad('no rows to import');
      if (rows.length > 5000) throw bad('import at most 5000 terms at a time');
      const results = { total: rows.length, concepts_created: 0, terms_written: 0, failed: 0, errors: [] };
      for (const r of rows) {
        try {
          if (!r.concept_key || !r.term || !r.lang) throw bad('concept_key, term and lang are required');
          const key = String(r.concept_key).trim().toLowerCase();
          const { rows: c } = await db.query(
            `INSERT INTO lexicon_concepts (concept_key, gloss)
             VALUES ($1, $2)
             ON CONFLICT (concept_key) DO UPDATE SET gloss = COALESCE(EXCLUDED.gloss, lexicon_concepts.gloss)
             RETURNING id, (xmax = 0) AS inserted`, [key, r.gloss || null]);
          if (c[0].inserted) results.concepts_created++;
          await db.query(
            `INSERT INTO lexicon_terms (concept_id, term, lang, register, weight, is_primary)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (term, lang, concept_id) DO UPDATE
                SET register = EXCLUDED.register, weight = EXCLUDED.weight, is_primary = EXCLUDED.is_primary`,
            [c[0].id, String(r.term).toLowerCase().trim(), String(r.lang).trim(),
             r.register || null,
             r.weight === '' || r.weight == null ? 1.0 : Number(r.weight),
             r.is_primary === true || String(r.is_primary).toLowerCase() === 'true']);
          results.terms_written++;
        } catch (err) {
          results.failed++;
          const msg = err.constraint === 'lexicon_terms_no_doubled_article'
            ? 'carries both the English article and the Hebrew Ha- prefix'
            : err.message;
          if (results.errors.length < 50) results.errors.push({ term: r.term, error: msg });
        }
      }
      return { status: 200, body: results };
    },
  },

  // -- screen 10: index tools --------------------------------------------------
  {
    // { url } for one page, { host } for a whole domain.
    method: 'POST', match: exact('/api/v1/admin/index/reindex'), right: 'admin',
    handle: async ({ db, body }) => {
      const { url, host } = body.parsed ?? {};
      if (url) {
        const page = await pageByUrl(db, url);
        if (!page) throw bad('no such page in the index');
        const domain = await domainById(db, page.domain_id);
        await forgetHashes(db, 'id = $1', [page.id]);
        const queued = await scheduleDomain(db, domain, { urls: [page.url] });
        return { status: 200, body: { url: page.url, pages_reset: 1, queued } };
      }
      if (host) {
        const domain = await domainByHost(db, host);
        if (!domain) throw bad('no such domain');
        const reset = await forgetHashes(db, 'domain_id = $1', [domain.id]);
        const queued = await scheduleDomain(db, domain);
        return { status: 200, body: { host: domain.host, pages_reset: reset, queued } };
      }
      throw bad('url or host is required');
    },
  },
  {
    method: 'POST', match: exact('/api/v1/admin/index/purge-page'), right: 'admin',
    handle: async ({ db, body, identity }) => {
      const url = body.parsed?.url;
      if (!url) throw bad('url is required');
      const { rowCount } = await db.query('DELETE FROM pages WHERE url = $1', [url]);
      if (rowCount === 0) throw bad('no such page in the index');
      await db.query('SELECT bump_index_version($1)', [identity.jubilee_id]);
      return { status: 200, body: { url, purged: true } };
    },
  },
  {
    // Clears the vectors so the embed job redoes them with the current model.
    method: 'POST', match: exact('/api/v1/admin/index/reembed'), right: 'admin',
    handle: async ({ db, body }) => {
      const { url, host } = body.parsed ?? {};
      let where; let params;
      if (url) {
        const page = await pageByUrl(db, url);
        if (!page) throw bad('no such page in the index');
        where = 'page_id = $1'; params = [page.id];
      } else if (host) {
        const domain = await domainByHost(db, host);
        if (!domain) throw bad('no such domain');
        where = 'page_id IN (SELECT id FROM pages WHERE domain_id = $1)'; params = [domain.id];
      } else {
        throw bad('url or host is required');
      }
      const { rowCount } = await db.query(
        `UPDATE chunks SET embedding = NULL, embedded_at = NULL WHERE ${where}`, params);
      return { status: 200, body: { chunks_reset: rowCount } };
    },
  },
  {
    method: 'GET', match: exact('/api/v1/admin/index/log'), right: 'view',
    handle: async ({ db, url }) => {
      const target = url.searchParams.get('url');
      if (!target) throw bad('url is required');
      let host;
      try { host = new URL(target).hostname.toLowerCase(); } catch { throw bad('url must be absolute'); }
      const domain = await domainByHost(db, host);
      const page = await pageByUrl(db, target);
      const [runs, failures, queue] = await Promise.all([
        domain ? db.query(
          `SELECT id, mode, started_at, finished_at, pages_seen, pages_changed, pages_failed, error
             FROM ingest_runs WHERE domain_id = $1 ORDER BY started_at DESC LIMIT 20`, [domain.id]) : { rows: [] },
        db.query(
          `SELECT status, reason, outcome, at FROM crawl_failures WHERE url = $1 ORDER BY at DESC LIMIT 20`,
          [target]),
        db.query(
          `SELECT priority, source, scheduled_for, claimed_by, claimed_at, attempts, last_error
             FROM crawl_queue WHERE url = $1`, [target]),
      ]);
      return {
        status: 200,
        body: {
          url: target,
          domain: domain ? { host: domain.host, status: domain.status, ingest_mode: domain.ingest_mode,
                             last_crawl_started: domain.last_crawl_started,
                             last_crawl_finished: domain.last_crawl_finished,
                             next_crawl_due: domain.next_crawl_due } : null,
          page: page ? { id: page.id } : null,
          ingest_runs: runs.rows,
          crawl_failures: failures.rows,
          queue: queue.rows,
        },
      };
    },
  },

  // -- screen 8: analytics ----------------------------------------------------
  {
    method: 'GET', match: exact('/api/v1/admin/analytics/overview'), right: 'view',
    handle: async ({ db, url }) => {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
      const since = [String(days)];
      const [byIntent, byLang, byPosition, concepts, top] = await Promise.all([
        db.query(
          `SELECT COALESCE(intent, 'unknown') AS intent, count(*) AS searches,
                  count(*) FILTER (WHERE COALESCE(zone_a_count,0) + COALESCE(zone_b_count,0) = 0) AS zero_results
             FROM search_queries WHERE created_at > now() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 2 DESC`, since),
        db.query(
          `SELECT COALESCE(lang, 'unknown') AS lang, count(*) AS searches
             FROM search_queries WHERE created_at > now() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, since),
        db.query(
          `SELECT ri.zone, ri.position, count(*) AS impressions,
                  count(*) FILTER (WHERE ri.clicked) AS clicks,
                  round(count(*) FILTER (WHERE ri.clicked)::numeric / NULLIF(count(*), 0), 4) AS ctr
             FROM result_impressions ri JOIN search_queries sq ON sq.id = ri.query_id
            WHERE sq.created_at > now() - ($1 || ' days')::interval AND ri.position <= 10
            GROUP BY 1, 2 ORDER BY 1, 2`, since),
        db.query(
          `SELECT c.concept_key, count(*) AS hits
             FROM search_queries sq, unnest(sq.expanded_concepts) AS x(concept_id)
             JOIN lexicon_concepts c ON c.id = x.concept_id
            WHERE sq.created_at > now() - ($1 || ' days')::interval
            GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, since),
        db.query(
          `SELECT normalized, count(*) AS times,
                  count(*) FILTER (WHERE COALESCE(zone_a_count,0) = 0) AS zone_a_empty
             FROM search_queries
            WHERE created_at > now() - ($1 || ' days')::interval AND normalized <> ''
            GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, since),
      ]);
      return {
        status: 200,
        body: {
          days,
          by_intent: byIntent.rows,
          by_language: byLang.rows,
          ctr_by_position: byPosition.rows,
          concept_hits: concepts.rows,
          top_queries: top.rows,
        },
      };
    },
  },
];
