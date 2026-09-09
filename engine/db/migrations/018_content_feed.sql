-- 018 — the content feed ingest mode (R5).
--
-- §9 gives three ways in: source markdown, a crawl, and a publish webhook. On
-- the Jubilee network none of them reaches the articles.
--
--   * Source markdown needs a `source_root` on a filesystem the engine can
--     read. Decision D5 -- where T1 source markdown lives -- has never been
--     answered, and the checkouts on this machine hold empty article
--     directories.
--   * A crawl cannot see the content. JubileeVerse renders article bodies
--     client-side: the text is absent from the served HTML *and* from the RSC
--     flight payload, the article cards carry no <a href> at all, and
--     /sitemap.xml returns the application shell rather than XML. Headless
--     rendering was implemented (src/crawl/render.js) and does not help,
--     because the missing piece is discovery, not JavaScript.
--   * The webhook is push-only. It keeps an index fresh; it cannot populate an
--     empty one, and it has no way to enumerate what already exists.
--
-- So a fourth mode: the publisher exposes a paged, incremental list of what it
-- wants searchable, and the engine walks it. The content is not being scraped
-- out of a page's markup -- it is being handed over, by the site that owns it,
-- in a shape it controls. A front-end redesign can no longer silently empty
-- this index, which is what a crawl-based pipeline risks every time.
--
-- The contract is documented in docs/SEARCH-FEED.md.

ALTER TYPE ingest_mode ADD VALUE IF NOT EXISTS 'feed';

-- The incremental high-water mark: the newest `updated_at` a successful run
-- imported. The next run asks the publisher for records newer than this, so a
-- routine sync moves a handful of rows rather than the whole corpus.
--
-- On the run row rather than on the domain, deliberately. A failed run must not
-- advance it -- if it did, the records that run missed would never be asked for
-- again -- and keeping it here means the history says which run saw what.
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS high_water_mark TIMESTAMPTZ;

-- `pages_seen` / `pages_changed` are named for a crawl. A feed run counts items,
-- most of which do not become a page write, so the two are recorded separately
-- rather than overloading columns whose names would then mislead.
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS items_seen INT NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS items_written INT NOT NULL DEFAULT 0;

-- The importer asks "what is the newest thing I have successfully taken from
-- this domain", which is this index exactly.
CREATE INDEX IF NOT EXISTS ingest_runs_high_water_idx
    ON ingest_runs (domain_id, mode, high_water_mark DESC)
    WHERE error IS NULL AND high_water_mark IS NOT NULL;

COMMENT ON COLUMN ingest_runs.high_water_mark IS
  'Newest source updated_at imported by this run. Only set when the run succeeded; the next incremental sync starts here.';
