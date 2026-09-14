-- 036 — site boilerplate is not content.
--
-- Measured on the first network crawl (2026-09-14): CDN articles chunk to 9.3
-- chunks a page, crawled pages to 33.5, and 1,825 distinct chunk texts recur on
-- more than three pages -- navigation, "related messages" lists, member
-- rosters, category menus. Those chunks embed to vectors that sit near every
-- query about the site's subject, so the semantic arm returns menus: on the
-- 100-pair gold set, semantic recall@10 fell from 55% (600 pages) to 9%
-- (2,038 pages) and hybrid from 58% to 30%.
--
-- The rule is the classic one: a block of text that appears on several pages
-- of the SAME site is template, not article. Flagged chunks keep their row (the
-- page's chunk ordinals stay meaningful, and a snippet can still be cut from
-- the article's own chunks) but lose their vector and are excluded from
-- retrieval and from the embed queue. Marking is idempotent and runs at the
-- start of every embed job, so a crawl never leaves fresh boilerplate live for
-- more than one cycle.

ALTER TABLE chunks ADD COLUMN boilerplate BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN chunks.boilerplate IS
    'TRUE when this chunk''s text appears on several pages of the same domain (template, not content). Never embedded, never retrieved.';

CREATE OR REPLACE FUNCTION mark_boilerplate_chunks(min_pages INT DEFAULT 3)
RETURNS INT AS $fn$
DECLARE
    marked INT;
BEGIN
    WITH repeated AS (
        SELECT p.domain_id, md5(c.text) AS h
          FROM chunks c JOIN pages p ON p.id = c.page_id
         WHERE NOT c.boilerplate
         GROUP BY p.domain_id, md5(c.text)
        HAVING count(DISTINCT c.page_id) >= min_pages
    ),
    flagged AS (
        UPDATE chunks c
           SET boilerplate = TRUE, embedding = NULL, embedded_at = NULL,
               embed_attempts = 0, embed_error = NULL
          FROM pages p, repeated r
         WHERE p.id = c.page_id AND r.domain_id = p.domain_id AND r.h = md5(c.text)
           AND NOT c.boilerplate
        RETURNING c.id
    )
    SELECT count(*) INTO marked FROM flagged;
    RETURN marked;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION mark_boilerplate_chunks(INT) IS
    'Flags chunks whose text recurs on >= min_pages pages of one domain as boilerplate and drops their vectors. Idempotent; returns the number newly flagged.';

-- The pending-embedding index must not keep offering boilerplate to the job.
DROP INDEX IF EXISTS chunks_pending_idx;
CREATE INDEX chunks_pending_idx ON chunks (model_id) WHERE embedded_at IS NULL AND NOT boilerplate;
