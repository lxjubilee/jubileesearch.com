-- 019 — CDN bundle ingest, and a status for content withdrawn at source.
--
-- The JubileeVerse articles are not in Postgres and never were, for the site's
-- own purposes: `src/lib/articles.ts` says they are "read from the CDN and
-- nowhere else". They are published as per-category bundles:
--
--   https://cdn.jubileeverse.com/articles/<folder>/articles.json   the manifest
--   https://cdn.jubileeverse.com/articles/<folder>/<file>.md       frontmatter + body
--
-- That is markdown with YAML frontmatter, which is exactly what R5 (§9.1)
-- already ingests -- so this adds a transport, not a second parser.

ALTER TYPE ingest_mode ADD VALUE IF NOT EXISTS 'cdn';

-- Withdrawn at source: the article was indexed, and a later manifest no longer
-- lists it.
--
-- NOT 'gone', which the crawler sets on a 404 and which reads as "the URL is
-- dead". A manifest that stops listing a slug is an editorial decision, and the
-- file usually still sits on the CDN -- conflating the two would lose the
-- difference between "the publisher unpublished this" and "the fetch broke",
-- which are answered by different people.
--
-- NOT a delete, either. `servable_pages` requires status = 'indexed', so this
-- alone removes the page from every result while keeping the row, its chunks
-- and its click history. Re-publishing is then a status change rather than a
-- re-crawl, and a manifest that breaks does not destroy the index.
ALTER TYPE page_status ADD VALUE IF NOT EXISTS 'unpublished';

COMMENT ON TYPE page_status IS
  'discovered/fetched/extracted/indexed are the pipeline; quarantined and rejected are safety and quality; gone is a 404 at source; unpublished is withdrawn from a publisher manifest while still fetchable.';
