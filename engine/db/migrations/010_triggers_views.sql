-- 010 — the body_tsv trigger, updated_at, and the structural serving gate.

-- §7.2: "Because Postgres ships no stemming dictionary for Hebrew or Hindi,
-- those languages fall back to the `simple` configuration." Anything we have no
-- dictionary for gets `simple` rather than being stemmed as though it were
-- English, which would be worse than not stemming at all.
CREATE FUNCTION ts_config_for(lang TEXT) RETURNS regconfig AS $$
    SELECT CASE split_part(COALESCE(lang, ''), '-', 1)
        WHEN 'en' THEN 'english'::regconfig
        WHEN 'ro' THEN 'romanian'::regconfig
        WHEN 'es' THEN 'spanish'::regconfig
        WHEN 'fr' THEN 'french'::regconfig
        WHEN 'de' THEN 'german'::regconfig
        WHEN 'pt' THEN 'portuguese'::regconfig
        WHEN 'it' THEN 'italian'::regconfig
        WHEN 'nl' THEN 'dutch'::regconfig
        WHEN 'ru' THEN 'russian'::regconfig
        ELSE 'simple'::regconfig          -- he, hi, and everything unlisted
    END;
$$ LANGUAGE sql IMMUTABLE;

-- Title carries weight A, description B, body C: a page whose *title* is the
-- query is a better answer than one that mentions it once in paragraph forty.
CREATE FUNCTION pages_tsv_update() RETURNS TRIGGER AS $$
DECLARE cfg regconfig := ts_config_for(NEW.language);
BEGIN
    NEW.body_tsv :=
        setweight(to_tsvector(cfg, unaccent(COALESCE(NEW.title, ''))), 'A') ||
        setweight(to_tsvector(cfg, unaccent(COALESCE(NEW.description, ''))), 'B') ||
        setweight(to_tsvector(cfg, unaccent(COALESCE(NEW.body_text, ''))), 'C');
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER pages_tsv_trigger
    BEFORE INSERT OR UPDATE OF title, description, body_text, language ON pages
    FOR EACH ROW EXECUTE FUNCTION pages_tsv_update();

CREATE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER domains_touch BEFORE UPDATE ON domains
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- The serving gate.
--
-- Principle P1 is default deny, and acceptance criterion 21 has to be provable
-- "by direct database query". So the rule is not a WHERE clause in application
-- code that somebody can forget to write — retrieval reads this view and only
-- this view, and the view cannot return a page that has not earned its way out.
--
--   T1  trusted, skips classification entirely (§4)
--   T2  approved at domain level, spot-checked at page level
--   T3  must carry safety_verdict = 'safe' — 'review', 'unclassified', NULL and
--       'unsafe' are all equally unservable
--   T0  quarantine, never returned at any time
--
-- A crawl that outruns the classifier therefore returns nothing, rather than
-- something unchecked.
-- ---------------------------------------------------------------------------
CREATE VIEW servable_pages AS
SELECT p.*
FROM pages p
JOIN domains d ON d.id = p.domain_id
WHERE p.status = 'indexed'
  AND NOT p.suppressed
  AND d.status = 'active'
  AND p.tier <> 'T0'
  AND (
        p.tier = 'T1'
     OR (p.tier = 'T2' AND COALESCE(p.safety_verdict, 'unclassified') <> 'unsafe')
     OR (p.tier = 'T3' AND p.safety_verdict = 'safe')
      );

COMMENT ON VIEW servable_pages IS
    'The only page source the query pipeline may read. Enforces P1 default-deny and acceptance criterion 21 structurally.';

-- Zone A is not a scoring outcome, it is a structural guarantee (P8, §13.5).
-- Verified-T1-only, expressed once, so no ranking change can leak into it.
-- Acceptance criterion 11 is a SELECT against this.
CREATE VIEW zone_a_pages AS
SELECT p.* FROM servable_pages p
JOIN domains d ON d.id = p.domain_id
WHERE p.tier = 'T1' AND d.zone_a_eligible;

CREATE VIEW zone_b_pages AS
SELECT p.* FROM servable_pages p
WHERE p.tier IN ('T2','T3');
