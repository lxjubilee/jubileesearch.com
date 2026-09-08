// Ingest write path: a mapped page goes in, `pages` and `chunks` come out.
//
// The rule that governs everything here is §9.5's change detection: "if
// content_hash matches the stored value, update last_fetched_at and stop. No
// re-extraction, no re-embedding, no reindex. Only changed pages consume GPU
// time." Acceptance criterion 3 tests exactly this, and §9.1 puts the saving at
// roughly 70% of nightly compute on the owned network.

import { withTransaction } from '../db.js';
import { urlHash, normalizeUrl } from './markdown.js';
import { chunkMarkdown } from './chunker.js';

/**
 * Insert or update one page and, when its content changed, replace its chunks.
 *
 * @param {object} domain   row from `domains`
 * @param {object} mapped   from mapToPage()
 * @param {string} markdown the body, for chunking
 * @param {object} opts     { priority } 1 for publish-push (§12.2)
 * @returns {{page_id: number, status: 'unchanged'|'created'|'updated'|'rejected', reason?: string}}
 */
export async function upsertPage(domain, mapped, markdown, opts = {}) {
  const url = normalizeUrl(mapped.url);
  const hash = urlHash(url);

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, content_hash, status FROM pages
        WHERE domain_id = $1 AND url_hash = $2 FOR UPDATE`,
      [domain.id, hash]);

    const prior = existing.rows[0];

    if (prior && prior.content_hash && mapped.content_hash.equals(prior.content_hash)) {
      await client.query(
        `UPDATE pages SET last_fetched_at = now() WHERE id = $1`, [prior.id]);
      return { page_id: Number(prior.id), status: 'unchanged' };
    }

    // Thin content is rejected before it takes a row's worth of index space
    // (§12.1). It is still recorded, so the admin console can answer "why is
    // this URL not in search" without a crawl log dive.
    const { chunks, rejected } = chunkMarkdown(markdown, { title: mapped.title });
    if (rejected) {
      const id = await writePage(client, domain, mapped, url, hash, 'rejected', prior?.id);
      await client.query('DELETE FROM chunks WHERE page_id = $1', [id]);
      return { page_id: id, status: 'rejected', reason: rejected };
    }

    const pageId = await writePage(client, domain, mapped, url, hash, 'indexed', prior?.id);

    await replaceChunks(client, pageId, chunks);

    if (opts.priority === 1) await bumpEmbeddingPriority(client, pageId);

    return { page_id: pageId, status: prior ? 'updated' : 'created' };
  });
}

/**
 * Replace a page's chunks.
 *
 * Wholesale rather than diffed. Ordinals shift when a paragraph is inserted, so
 * a diff would rewrite most of them anyway, and the delete-insert is one
 * statement each inside the caller's transaction.
 *
 * Shared by the source-markdown path and the crawl path, so there is one place
 * that decides what a chunk row looks like.
 */
export async function replaceChunks(client, pageId, chunks) {
  await client.query('DELETE FROM chunks WHERE page_id = $1', [pageId]);
  if (chunks.length === 0) return 0;

  await client.query(
    `INSERT INTO chunks (page_id, ordinal, heading_path, text, token_count, model_id)
     SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::text[])`,
    [pageId,
     chunks.map((c) => c.ordinal),
     chunks.map((c) => c.heading_path),
     // What gets embedded is the prefixed form (§12.1); what gets stored as the
     // chunk text -- and therefore what a snippet is cut from -- is the body
     // alone. The embedding job reconstructs the prefix from heading_path and
     // the page title rather than storing it twice.
     chunks.map((c) => c.text),
     chunks.map((c) => c.token_count),
     // embedded_at stays NULL, which is what the embedding job selects on.
     chunks.map(() => null)]);

  return chunks.length;
}

async function writePage(client, domain, m, url, hash, status, priorId) {
  const { rows } = await client.query(
    `INSERT INTO pages (
        domain_id, url, url_hash, source_path, status, tier,
        content_hash, title, description, author, persona, category, office,
        published_at, modified_at, language, tags, characters, related_slugs,
        og_image_url, body_text, word_count, last_fetched_at, last_indexed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now(), now())
     ON CONFLICT (domain_id, url_hash) DO UPDATE SET
        url = EXCLUDED.url, source_path = EXCLUDED.source_path,
        status = EXCLUDED.status, tier = EXCLUDED.tier,
        content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
        description = EXCLUDED.description, author = EXCLUDED.author,
        persona = EXCLUDED.persona, category = EXCLUDED.category,
        office = EXCLUDED.office, published_at = EXCLUDED.published_at,
        modified_at = EXCLUDED.modified_at, language = EXCLUDED.language,
        tags = EXCLUDED.tags, characters = EXCLUDED.characters,
        related_slugs = EXCLUDED.related_slugs, og_image_url = EXCLUDED.og_image_url,
        body_text = EXCLUDED.body_text, word_count = EXCLUDED.word_count,
        last_fetched_at = now(), last_indexed_at = now(),
        fetch_failures = 0
     RETURNING id`,
    [domain.id, url, hash, m.source_path, status, domain.tier,
     m.content_hash, m.title, m.description, m.author, m.persona, m.category, m.office,
     m.published_at, m.modified_at, m.language ?? domain.language_hint, m.tags,
     m.characters, m.related_slugs, m.og_image_url, m.body_text, m.word_count]);
  return Number(rows[0]?.id ?? priorId);
}

// §12.2: "Publish-push chunks jump the queue at priority = 1 to meet the
// 60-second freshness target." The embedding job orders by this.
async function bumpEmbeddingPriority(client, pageId) {
  await client.query(
    `INSERT INTO crawl_queue (url, url_hash, domain_id, tier, priority, source, scheduled_for)
     SELECT p.url, p.url_hash, p.domain_id, p.tier, 1, 'webhook', now()
       FROM pages p WHERE p.id = $1
     ON CONFLICT (url_hash) DO UPDATE
        SET priority = 1, scheduled_for = now(), claimed_by = NULL, attempts = 0`,
    [pageId]);
}

/**
 * §9.2: "`unpublish` marks the page `gone`, removes it from results immediately,
 * and cascades a chunk delete."
 *
 * Immediately is the operative word. `gone` is not in servable_pages, so the
 * page leaves results the moment this commits -- there is no job to wait for.
 */
export async function markGone(domainId, url) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE pages SET status = 'gone', last_indexed_at = now()
        WHERE domain_id = $1 AND url_hash = $2 RETURNING id`,
      [domainId, urlHash(normalizeUrl(url))]);
    if (!rows[0]) return { page_id: null, status: 'not_found' };
    await client.query('DELETE FROM chunks WHERE page_id = $1', [rows[0].id]);
    return { page_id: Number(rows[0].id), status: 'gone' };
  });
}

/**
 * §9.6 exact deduplication. "Same content_hash across pages means one canonical
 * page is indexed and the rest are marked duplicates pointing to it."
 *
 * Canonical preference order, from the spec: the page whose URL matches
 * canonical_url, then the T1 page, then the oldest first_seen_at. Syndicated
 * Jubilee articles appear on several network domains, so this is not an edge
 * case -- without it, one article occupies three Zone A slots.
 */
export async function dedupeExact(db) {
  const { rowCount } = await db.query(`
    WITH ranked AS (
        SELECT p.id, p.content_hash,
               ROW_NUMBER() OVER (
                   PARTITION BY p.content_hash
                   ORDER BY (p.canonical_url IS NOT NULL AND p.canonical_url = p.url) DESC,
                            (p.tier = 'T1') DESC,
                            p.first_seen_at ASC,
                            p.id ASC) AS rank
        FROM pages p
        WHERE p.status = 'indexed' AND p.content_hash IS NOT NULL
    )
    UPDATE pages SET status = 'rejected',
                     safety_reasons = COALESCE(safety_reasons, '{}'::jsonb)
                                    || jsonb_build_object('duplicate_of', canonical.id)
    FROM ranked dup
    JOIN ranked canonical
      ON canonical.content_hash = dup.content_hash AND canonical.rank = 1
    WHERE pages.id = dup.id AND dup.rank > 1`);
  return rowCount;
}
