// Writing a crawled page.
//
// The source-markdown path in `ingest/service.js` and this one converge on the
// same `pages` row and the same chunker; what differs is everything a fetch
// carries that a file does not -- an HTTP status, validators for the next
// conditional GET, a canonical URL the page declared, a safety verdict, a link
// graph, and a SimHash for near-duplicate detection.

import { withTransaction } from '../db.js';
import { replaceChunks } from '../ingest/service.js';
import { chunkMarkdown } from '../ingest/chunker.js';
import { urlHash, normalizeUrl } from '../ingest/markdown.js';
import { simhash, bands, toSigned, findNearDuplicates, pickCanonical } from './simhash.js';

/**
 * @param {object} domain     row from `domains`
 * @param {object} fetched    from fetchPage()
 * @param {object} extracted  from extract() or the PDF path
 * @param {object} verdict    from safety/gates.js evaluate()
 * @param {object} cfg        ranking config
 */
export async function upsertCrawledPage(domain, fetched, extracted, verdict, cfg) {
  const url = normalizeUrl(fetched.final_url ?? fetched.url);
  const hash = urlHash(url);

  const hashValue = simhash(extracted.body_text);
  const [b0, b1, b2, b3] = bands(hashValue);

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, content_hash FROM pages
        WHERE domain_id = $1 AND url_hash = $2 FOR UPDATE`, [domain.id, hash]);
    const prior = existing.rows[0];

    // §9.5 change detection. Reached only when the conditional GET did not
    // already answer 304 -- a server with no ETag and no Last-Modified sends the
    // whole body every time, and this is where that still costs nothing
    // downstream.
    const unchanged = prior?.content_hash && extracted.content_hash.equals(prior.content_hash);

    const { chunks, rejected } = unchanged
      ? { chunks: [], rejected: null }
      : chunkMarkdown(extracted.markdown, { title: extracted.title });

    // §4: the verdict decides whether the page is servable, and `servable_pages`
    // enforces it. `status` here is what that view reads.
    const status = rejected ? 'rejected'
      : verdict.verdict === 'safe' ? 'indexed'
      : verdict.verdict === 'unsafe' ? 'rejected'
      : 'quarantined';

    const { rows } = await client.query(
      `INSERT INTO pages (
          domain_id, url, url_hash, canonical_url, status, tier,
          http_status, content_type, etag, last_modified_http, content_hash,
          title, description, author, published_at, modified_at, language,
          body_text, word_count, og_image_url, outlink_count,
          simhash, simhash_b0, simhash_b1, simhash_b2, simhash_b3,
          safety_verdict, safety_score, safety_reasons,
          last_fetched_at, last_indexed_at, fetch_failures)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29::jsonb, now(), now(), 0)
       ON CONFLICT (domain_id, url_hash) DO UPDATE SET
          url = EXCLUDED.url, canonical_url = EXCLUDED.canonical_url,
          status = EXCLUDED.status, http_status = EXCLUDED.http_status,
          content_type = EXCLUDED.content_type, etag = EXCLUDED.etag,
          last_modified_http = EXCLUDED.last_modified_http,
          content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
          description = EXCLUDED.description, author = EXCLUDED.author,
          published_at = EXCLUDED.published_at, modified_at = EXCLUDED.modified_at,
          language = EXCLUDED.language, body_text = EXCLUDED.body_text,
          word_count = EXCLUDED.word_count, og_image_url = EXCLUDED.og_image_url,
          outlink_count = EXCLUDED.outlink_count,
          simhash = EXCLUDED.simhash, simhash_b0 = EXCLUDED.simhash_b0,
          simhash_b1 = EXCLUDED.simhash_b1, simhash_b2 = EXCLUDED.simhash_b2,
          simhash_b3 = EXCLUDED.simhash_b3,
          safety_verdict = EXCLUDED.safety_verdict, safety_score = EXCLUDED.safety_score,
          safety_reasons = EXCLUDED.safety_reasons,
          last_fetched_at = now(), last_indexed_at = now(), fetch_failures = 0
       RETURNING id`,
      [domain.id, url, hash, extracted.canonical_url, status, domain.tier,
       fetched.status, fetched.content_type, fetched.etag,
       fetched.last_modified ? new Date(fetched.last_modified).toISOString() : null,
       extracted.content_hash, extracted.title, extracted.description, extracted.author,
       extracted.published_at, extracted.modified_at,
       extracted.language ?? domain.language_hint,
       extracted.body_text, extracted.word_count,
       // §9.4: "Image URLs are recorded as metadata on T1 only and discarded on
       // T2 and T3." Not a nicety -- it keeps the external tiers free of any
       // image reference at all, which is the cleanest reading of P10.
       domain.tier === 'T1' ? extracted.og_image_url : null,
       extracted.outlink_count,
       toSigned(hashValue).toString(), b0, b1, b2, b3,
       verdict.verdict, verdict.score, JSON.stringify(verdict.reasons ?? []),
      ]);

    const pageId = Number(rows[0].id);

    if (unchanged) {
      return { page_id: pageId, status: 'unchanged' };
    }
    if (rejected) {
      await replaceChunks(client, pageId, []);
      return { page_id: pageId, status: 'rejected', reason: rejected };
    }

    await replaceChunks(client, pageId, chunks);
    await writeLinks(client, pageId, extracted.links);

    return {
      page_id: pageId,
      status: prior ? 'updated' : 'created',
      chunks: chunks.length,
      verdict: verdict.verdict,
    };
  });
}

/**
 * Replace the page's outbound links (§9.5 step 4).
 *
 * The link graph is what trust-graph discovery walks (§10.2) and what feeds
 * `inlink_count`, which is a component of the structural quality score.
 */
async function writeLinks(client, pageId, links) {
  await client.query('DELETE FROM links WHERE from_page_id = $1', [pageId]);
  if (!links?.length) return;

  // A page with 4,000 links is a link farm or a sitemap rendered as HTML.
  // Recording all of them helps nothing and costs a lot.
  const capped = links.slice(0, 500);

  await client.query(
    `INSERT INTO links (from_page_id, to_url_hash, to_url, to_host, anchor_text, rel, is_internal)
     SELECT $1, sha256(convert_to(u.url, 'UTF8')), u.url, u.host, u.anchor, u.rel, u.internal
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[])
            AS u(url, anchor, rel, internal, host)
     ON CONFLICT (from_page_id, to_url_hash) DO NOTHING`,
    [pageId,
     capped.map((l) => l.to_url),
     capped.map((l) => l.anchor_text),
     capped.map((l) => l.rel),
     capped.map((l) => l.is_internal),
     // Denormalised so trust-graph discovery is a GROUP BY rather than a regex
     // over the largest table in the schema (migration 015).
     capped.map((l) => hostOf(l.to_url))]);
}

/**
 * Near-duplicate resolution (§9.6).
 *
 * Run after the page is written, because the canonical choice may fall on the
 * page that just arrived -- a T1 syndication of a T2 article should win, and it
 * cannot win a comparison it was not part of.
 */
export async function resolveNearDuplicates(db, pageId, cfg) {
  const { rows } = await db.query(
    `SELECT id, url, canonical_url, tier, first_seen_at, simhash
       FROM pages WHERE id = $1`, [pageId]);
  const page = rows[0];
  if (!page?.simhash) return { checked: false };

  const maxDistance = Math.round(cfg.near_duplicate_max_distance ?? 3);
  const neighbours = await findNearDuplicates(db, BigInt(page.simhash), {
    excludePageId: pageId,
    maxDistance,
  });
  if (neighbours.length === 0) return { checked: true, duplicates: 0 };

  const cluster = [page, ...neighbours];
  const canonical = pickCanonical(cluster);

  const losers = cluster.filter((p) => Number(p.id) !== Number(canonical.id)).map((p) => Number(p.id));
  if (losers.length === 0) return { checked: true, duplicates: 0 };

  // The duplicates keep their rows -- the crawl record and the link graph are
  // still true -- but leave `servable_pages` through `duplicate_of`, and their
  // chunks go, because an embedded near-copy is exactly what pollutes vector
  // search with the same passage three times.
  await db.query('DELETE FROM chunks WHERE page_id = ANY($1::bigint[])', [losers]);
  await db.query(
    `UPDATE pages SET duplicate_of = $2 WHERE id = ANY($1::bigint[])`,
    [losers, Number(canonical.id)]);
  // A page that was previously canonical and has now lost must not point at
  // itself through a chain.
  await db.query('UPDATE pages SET duplicate_of = NULL WHERE id = $1', [Number(canonical.id)]);

  return { checked: true, duplicates: losers.length, canonical: Number(canonical.id) };
}

/** §9.4: a 404 or 410 is a fact. The page leaves the index immediately. */
export async function markGoneByUrl(db, domainId, url) {
  const { rows } = await db.query(
    `WITH gone AS (
        UPDATE pages SET status = 'gone', last_fetched_at = now()
         WHERE domain_id = $1 AND url_hash = $2 RETURNING id),
         cleared AS (DELETE FROM chunks WHERE page_id IN (SELECT id FROM gone))
     SELECT count(*) AS n FROM gone`,
    [domainId, urlHash(normalizeUrl(url))]);
  return Number(rows[0].n);
}

/** Record a non-success outcome so acceptance criterion 5 is a query (§14 migration). */
export async function recordFailure(db, domainId, url, result) {
  await db.query(
    `INSERT INTO crawl_failures (domain_id, url, status, reason, outcome)
     VALUES ($1, $2, $3, $4, $5)`,
    [domainId, url, result.status ?? null, String(result.reason ?? '').slice(0, 500), result.outcome]);

  if (result.outcome === 'error') {
    await db.query(
      `UPDATE pages SET fetch_failures = fetch_failures + 1
        WHERE domain_id = $1 AND url_hash = $2`,
      [domainId, urlHash(normalizeUrl(url))]);
  }
}

/** Recompute inlink counts. Cheap enough nightly, far too expensive per page. */
export async function recomputeInlinks(db) {
  const { rowCount } = await db.query(`
    UPDATE pages p SET inlink_count = COALESCE(c.n, 0)
      FROM (SELECT l.to_url_hash, count(DISTINCT l.from_page_id) AS n
              FROM links l GROUP BY l.to_url_hash) c
     WHERE p.url_hash = c.to_url_hash
       AND p.inlink_count IS DISTINCT FROM COALESCE(c.n, 0)`);
  return rowCount;
}

/** Registrable host, lowercase, no leading www. Matches the backfill in 015. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
