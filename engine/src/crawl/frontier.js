// Frontier Service (§9.3).
//
//   * Selects domains where next_crawl_due <= now() and status = 'active'
//   * Seeds from sitemap.xml, sitemap_index.xml, and RSS or Atom feeds first;
//     falls back to link discovery only when no sitemap exists
//   * Enforces per-domain page and depth caps
//   * Applies a per-host politeness lock (in fetcher.js, where the requests are)
//   * Adaptive backoff on unchanged domains
//
// The queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED` (§6.1),
// which is the same mechanism the job queue uses. No broker, P3.

import { pool } from '../db.js';
import { admit, nextInterval } from './policy.js';
import { parseSitemap, CONVENTIONAL_SITEMAP_PATHS } from './sitemap.js';
import { robotsFor, USER_AGENT } from './fetcher.js';
import { normalizeUrl } from '../ingest/markdown.js';

const TIER_FLOOR_HOURS = { T1: 24, T2: 168, T3: 720, T0: 720 };

/**
 * Add URLs to the frontier. Everything that reaches the queue has already passed
 * `admit`, so the fetcher never spends a request discovering that a URL was
 * never eligible.
 *
 * @returns {Promise<{queued: number, refused: Array}>}
 */
export async function enqueue(db, urls, domain, options = {}) {
  const { depth = 0, source = 'crawl', discoveredFrom = null, priority = null } = options;

  const accepted = [];
  const refused = [];

  for (const raw of urls) {
    const verdict = admit(raw, domain, { depth });
    if (!verdict.allowed) { refused.push({ url: raw, reason: verdict.reason }); continue; }
    accepted.push(normalizeUrl(verdict.url));
  }

  if (accepted.length === 0) return { queued: 0, refused };

  // Deduplicate within the batch before the insert: a page linking to the same
  // article twice would otherwise make ON CONFLICT fire against a row inserted
  // by the same statement, which Postgres refuses.
  const unique = [...new Set(accepted)];

  // §8.3 max_pages. Counted against what is already indexed plus what is already
  // queued, so a cap of 500 means 500 pages rather than 500 per run.
  const budget = await remainingBudget(db, domain);
  const admitted = budget === null ? unique : unique.slice(0, Math.max(0, budget));

  if (admitted.length === 0) {
    return { queued: 0, refused: [...refused, { url: '(batch)', reason: `max_pages ${domain.max_pages} reached` }] };
  }

  const { rowCount } = await db.query(
    `INSERT INTO crawl_queue (url, url_hash, domain_id, tier, priority, depth, source, discovered_from)
     SELECT u.url, u.hash, $2, $3, $4, $5, $6, $7
       FROM unnest($1::text[]) AS u(url)
       CROSS JOIN LATERAL (SELECT sha256(convert_to(u.url, 'UTF8')) AS hash) h(hash)
     ON CONFLICT (url_hash) DO NOTHING`,
    [admitted, domain.id, domain.tier,
     priority ?? defaultPriority(domain.tier), depth, source, discoveredFrom]);

  return { queued: rowCount, refused };
}

// Lower runs first (§7.4). Publish-push uses 1; owned reconciliation outranks
// the whitelist, which outranks open-web discovery.
const defaultPriority = (tier) => ({ T1: 10, T2: 50, T3: 100, T0: 200 })[tier] ?? 100;

async function remainingBudget(db, domain) {
  if (domain.max_pages === null || domain.max_pages === undefined) return null;
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM pages WHERE domain_id = $1 AND status <> 'gone')
          + (SELECT count(*) FROM crawl_queue WHERE domain_id = $1) AS used`,
    [domain.id]);
  return domain.max_pages - Number(rows[0].used);
}

/**
 * Seed a domain's frontier (§9.3).
 *
 * Sitemaps first, and the ordering is the point: a sitemap gives the whole set
 * of a site's URLs in one request. Link discovery finds them one fetch at a
 * time, and finds the navigation along with them -- so under a 500-page cap it
 * is the difference between indexing a site and indexing its menus.
 */
export async function seedDomain(db, domain) {
  const origin = `https://${domain.host}`;
  const candidates = [];

  // robots.txt names its own sitemaps, and that is the authoritative list.
  if (domain.respect_robots !== false) {
    const robots = await robotsFor(origin);
    candidates.push(...(robots.parsed.sitemaps ?? []));
  }
  candidates.push(...(domain.sitemap_urls ?? []));
  if (candidates.length === 0) {
    candidates.push(...CONVENTIONAL_SITEMAP_PATHS.map((p) => `${origin}${p}`));
  }

  const seen = new Set();
  const urls = [];
  let sitemapsRead = 0;

  // Breadth-first through sitemap indexes, capped: a sitemap index pointing at
  // a thousand sitemaps is a crawl of its own.
  const queue = [...new Set(candidates)];
  while (queue.length && sitemapsRead < 25 && urls.length < 50_000) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);

    const xml = await fetchText(target);
    if (!xml) continue;
    sitemapsRead++;

    const { kind, entries } = parseSitemap(xml);
    for (const entry of entries) {
      if (entry.isIndex || kind === 'sitemapindex') queue.push(entry.url);
      else urls.push(entry);
    }
  }

  if (urls.length === 0) {
    // §9.3: link discovery is the fallback, "only when no sitemap exists". The
    // home page is the seed and the extractor's links carry it from there.
    const result = await enqueue(db, [origin], domain, { depth: 0, source: 'crawl' });
    return { strategy: 'link_discovery', sitemaps: sitemapsRead, ...result };
  }

  // Freshest first. lastmod is a hint from the site and is often wrong, but
  // wrong-and-ordered still beats unordered when a cap will cut the tail off.
  urls.sort((a, b) => new Date(b.lastmod ?? 0) - new Date(a.lastmod ?? 0));

  const result = await enqueue(db, urls.map((u) => u.url), domain, { depth: 0, source: 'crawl' });
  return { strategy: 'sitemap', sitemaps: sitemapsRead, discovered: urls.length, ...result };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml,text/xml,application/rss+xml,*/*;q=0.5' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    // A site that answers every unknown path with its home page would otherwise
    // have its HTML parsed as a sitemap, which finds nothing and looks like a
    // site with an empty sitemap.
    if (type.includes('html')) return null;
    const text = await res.text();
    return text.length > 10 * 1024 * 1024 ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claim work. `FOR UPDATE SKIP LOCKED` lets several workers share the queue
 * without coordinating.
 *
 * Claims are grouped by host: the politeness lock in the fetcher serialises
 * requests to one host, so handing one worker URLs from twelve different hosts
 * lets it work while any single host is waiting out its crawl delay.
 */
export async function claimBatch(db, workerId, limit = 20) {
  const { rows } = await db.query(
    `WITH ready AS (
        SELECT q.id
          FROM crawl_queue q
          JOIN domains d ON d.id = q.domain_id
         WHERE q.claimed_by IS NULL
           AND q.scheduled_for <= now()
           AND d.status = 'active'
           AND q.attempts < 5
         ORDER BY q.priority, q.scheduled_for
         LIMIT $2
         FOR UPDATE OF q SKIP LOCKED)
     UPDATE crawl_queue q
        SET claimed_by = $1, claimed_at = now(), attempts = q.attempts + 1
       FROM ready
      WHERE q.id = ready.id
      RETURNING q.id, q.url, q.domain_id, q.tier, q.depth, q.source, q.attempts,
                q.discovered_from`,
    [workerId, limit]);
  return rows;
}

export const completeItem = (db, id) =>
  db.query('DELETE FROM crawl_queue WHERE id = $1', [id]);

/**
 * Return an item to the queue with backoff, or drop it once it has had enough
 * tries. Five attempts, matching the claim query's filter.
 */
export async function deferItem(db, id, delayMs, error) {
  await db.query(
    `UPDATE crawl_queue
        SET claimed_by = NULL, claimed_at = NULL,
            scheduled_for = now() + ($2 || ' milliseconds')::interval,
            last_error = $3
      WHERE id = $1`,
    [id, String(Math.round(delayMs)), String(error ?? '').slice(0, 500)]);
}

// A claim that outlives its worker -- a crash, a killed container -- would
// otherwise hold a URL forever. Anything claimed and untouched for an hour is
// assumed abandoned.
export async function reclaimStale(db, olderThanMinutes = 60) {
  const { rowCount } = await db.query(
    `UPDATE crawl_queue
        SET claimed_by = NULL, claimed_at = NULL
      WHERE claimed_by IS NOT NULL
        AND claimed_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)]);
  return rowCount;
}

/** Domains whose next crawl is due (§9.3). */
export async function dueDomains(db, { host = null, tier = null } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM domains
      WHERE status = 'active'
        AND ingest_mode IN ('crawl','hybrid')
        AND (next_crawl_due IS NULL OR next_crawl_due <= now())
        AND ($1::text IS NULL OR host = $1)
        AND ($2::text IS NULL OR tier = $2::trust_tier)
      ORDER BY tier, next_crawl_due NULLS FIRST`,
    [host, tier]);
  return rows;
}

/**
 * Close out a domain's run and set the next due time (§9.3 adaptive backoff).
 */
export async function finishRun(db, domain, { changed, failed }) {
  const floor = TIER_FLOOR_HOURS[domain.tier] ?? 24;
  const unchangedRuns = changed > 0 ? 0 : (domain.consecutive_unchanged_runs ?? 0) + 1;
  const interval = nextInterval(domain.crawl_interval_hours ?? floor, floor, unchangedRuns, changed > 0);

  await db.query(
    `UPDATE domains
        SET last_crawl_finished = now(),
            crawl_interval_hours = $2,
            next_crawl_due = now() + ($2 || ' hours')::interval,
            consecutive_unchanged_runs = $3,
            consecutive_failures = CASE WHEN $4 THEN consecutive_failures + 1 ELSE 0 END,
            status = CASE WHEN $4 AND consecutive_failures + 1 >= 3
                          THEN 'paused'::domain_status ELSE status END
      WHERE id = $1`,
    [domain.id, interval, unchangedRuns, failed > 0 && changed === 0]);

  return { interval_hours: interval, unchanged_runs: unchangedRuns };
}

export { pool };
