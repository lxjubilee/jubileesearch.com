-- 038 — site boilerplate removed at extraction, not just hidden at retrieval.
--
-- Migration 036 flagged repeated CHUNKS so they left the vector index. That
-- protected the semantic arm and nothing else: `pages.body_text` (the lexical
-- arm and the tsvector) and the snippets still carried the navigation, the
-- "related messages" lists and the member rosters -- 70% of the text on the
-- crawled sites. This is the classic site-level fix: every block of the
-- extracted markdown is hashed per page; a block that appears on `min_pages`
-- or more pages of the same domain is template, and the extractor drops it
-- before body_text, content_hash and the chunker ever see it
-- (src/crawl/extractor.js stripBoilerplate, src/crawl/store.js siteBoilerplate).
--
-- The first two pages of a site keep everything, because nothing has repeated
-- yet; the third page teaches the set, and a forced reingest (admin console,
-- or POST /domains/:id/reingest) rewrites the earlier ones.

CREATE TABLE page_blocks (
    domain_id  BIGINT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    page_id    BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    hash       TEXT   NOT NULL,
    PRIMARY KEY (page_id, hash)
);

CREATE INDEX page_blocks_domain_hash_idx ON page_blocks (domain_id, hash);

COMMENT ON TABLE page_blocks IS
    'One row per (page, markdown block) as extracted. Blocks shared by >= 3 pages of a domain are stripped as boilerplate on the next extraction.';

CREATE OR REPLACE FUNCTION site_boilerplate_hashes(p_domain_id BIGINT, min_pages INT DEFAULT 3)
RETURNS SETOF TEXT AS $fn$
    SELECT hash FROM page_blocks
     WHERE domain_id = p_domain_id
     GROUP BY hash
    HAVING count(DISTINCT page_id) >= min_pages;
$fn$ LANGUAGE sql STABLE;
