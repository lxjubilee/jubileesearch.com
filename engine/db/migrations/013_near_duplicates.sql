-- 013 — near-duplicate detection (§9.6).
--
-- "Near-duplicate: SimHash or MinHash over shingles with a configurable Hamming
-- distance threshold. Necessary because syndicated Jubilee articles appear on
-- multiple network domains."
--
-- Exact duplicates are already handled by `content_hash`. This is the other
-- case: the same article with a different footer, a different byline block, or
-- one paragraph of house introduction -- which is what syndication across 130
-- domains actually produces, and which `content_hash` sees as two documents.
--
-- Storage is a 64-bit SimHash plus its four 16-bit bands. The bands are the
-- index: two documents within a Hamming distance of 3 must, by the pigeonhole
-- principle, agree exactly on at least one of four bands. So the candidate
-- lookup is four equality probes rather than a scan, and the exact distance is
-- computed only on the handful that come back.
--
-- BIGINT is signed and a SimHash is not, so values above 2^63 arrive negative.
-- That is harmless: bit_count() and equality both work on the bit pattern, and
-- nothing ever does arithmetic on it. The bands are extracted before the cast,
-- in JavaScript, for the same reason.

ALTER TABLE pages
    ADD COLUMN simhash    BIGINT,
    ADD COLUMN simhash_b0 INT,
    ADD COLUMN simhash_b1 INT,
    ADD COLUMN simhash_b2 INT,
    ADD COLUMN simhash_b3 INT,
    ADD COLUMN duplicate_of BIGINT REFERENCES pages(id) ON DELETE SET NULL;

CREATE INDEX pages_simhash_b0_idx ON pages (simhash_b0) WHERE status = 'indexed';
CREATE INDEX pages_simhash_b1_idx ON pages (simhash_b1) WHERE status = 'indexed';
CREATE INDEX pages_simhash_b2_idx ON pages (simhash_b2) WHERE status = 'indexed';
CREATE INDEX pages_simhash_b3_idx ON pages (simhash_b3) WHERE status = 'indexed';
CREATE INDEX pages_duplicate_of_idx ON pages (duplicate_of) WHERE duplicate_of IS NOT NULL;

COMMENT ON COLUMN pages.duplicate_of IS
    'Set when this page is an exact or near duplicate of another. Canonical preference order is in spec 9.6: canonical_url match, then T1, then oldest first_seen_at.';

-- Hamming distance between two SimHashes. bit_count() arrived in Postgres 14
-- and the specification requires 16 or 17, so it is available.
CREATE FUNCTION simhash_distance(a BIGINT, b BIGINT) RETURNS INT AS $fn$
    SELECT bit_count((a # b)::bit(64))::int;
$fn$ LANGUAGE sql IMMUTABLE STRICT;

COMMENT ON FUNCTION simhash_distance(BIGINT, BIGINT) IS
    'Hamming distance between two 64-bit SimHash values. 0 is identical; the near-duplicate threshold is a ranking_config value.';

-- A duplicate is not servable. This is the one place `servable_pages` has to be
-- rebuilt, so the whole definition is restated rather than patched, and the
-- comment above it stays with it.
DROP VIEW zone_a_pages;
DROP VIEW zone_b_pages;
DROP VIEW servable_pages;

CREATE VIEW servable_pages AS
SELECT p.*
FROM pages p
JOIN domains d ON d.id = p.domain_id
WHERE p.status = 'indexed'
  AND NOT p.suppressed
  AND p.duplicate_of IS NULL
  AND d.status = 'active'
  AND p.tier <> 'T0'
  AND (
        p.tier = 'T1'
     OR (p.tier = 'T2' AND COALESCE(p.safety_verdict, 'unclassified') <> 'unsafe')
     OR (p.tier = 'T3' AND p.safety_verdict = 'safe')
      );

COMMENT ON VIEW servable_pages IS
    'The only page source the query pipeline may read. Enforces P1 default-deny and acceptance criterion 21 structurally.';

CREATE VIEW zone_a_pages AS
SELECT p.* FROM servable_pages p
JOIN domains d ON d.id = p.domain_id
WHERE p.tier = 'T1' AND d.zone_a_eligible;

CREATE VIEW zone_b_pages AS
SELECT p.* FROM servable_pages p
WHERE p.tier IN ('T2','T3');

INSERT INTO ranking_config (key, value, description) VALUES
    ('near_duplicate_max_distance', 3,
     'Maximum SimHash Hamming distance at which two pages are treated as near duplicates (spec 9.6). Raising it past 3 breaks the four-band candidate index.')
ON CONFLICT (key) DO NOTHING;
