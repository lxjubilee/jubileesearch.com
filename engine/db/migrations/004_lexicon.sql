-- 004 — lexicon: register and language bridge (R2, §7.5).
--
-- This is the table that makes "Holy Spirit" find a page that only ever says
-- "Ruach HaKodesh" (acceptance criterion 8). Retrieval quality on Jubilee's own
-- content depends on it more than on any ranking weight.

CREATE TABLE lexicon_concepts (
    id          BIGSERIAL PRIMARY KEY,
    concept_key TEXT NOT NULL UNIQUE,     -- 'ruach_hakodesh', 'teshuvah', 'yeshua'
    gloss       TEXT,                     -- short human description for the admin UI
    notes       TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lexicon_terms (
    id          BIGSERIAL PRIMARY KEY,
    concept_id  BIGINT NOT NULL REFERENCES lexicon_concepts(id) ON DELETE CASCADE,
    term        TEXT NOT NULL,            -- surface form, lowercase, unaccented
    lang        TEXT NOT NULL,            -- BCP-47
    register    TEXT,                     -- 'OHI','CCI','common', internal label only
    weight      NUMERIC(4,2) NOT NULL DEFAULT 1.00,  -- expansion weight, 1.00 = full
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (term, lang, concept_id)
);
CREATE INDEX lexicon_terms_term_idx    ON lexicon_terms (term);
CREATE INDEX lexicon_terms_concept_idx ON lexicon_terms (concept_id);

-- §13.3, "Hebrew article rule enforced in the data". Stored surface forms are
-- "Ruach HaKodesh" or "the Ruach Kodesh" -- never both articles at once. The
-- spec calls this "a validation rule in the lexicon editor, not a style
-- suggestion", so it is a constraint and not a lint the editor can skip.
--
-- Terms are stored lowercase, so the doubling cannot be spotted by the capital
-- H in "HaKodesh". It is caught by matching the article against the roots it
-- actually attaches to. Adding a root is a migration, which is the right amount
-- of friction: the obvious alternative, a bare /the\s+ha/, rejects "the harvest".
CREATE FUNCTION has_doubled_hebrew_article(term TEXT) RETURNS BOOLEAN AS $fn$
    SELECT $1 ~* ('\mthe\M\s+(\S+\s+)?ha-?(' || $roots$kodesh|mashiach|shem|torah|makom|aretz|olam|adon|kadosh|elyon|davar|derech|brit|mikdash|geulah|ruach|melech|kohen|navi|tzadik|shamayim$roots$ || ')');
$fn$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION has_doubled_hebrew_article(TEXT) IS
    'TRUE when a term carries both the English article and the Hebrew Ha- prefix, e.g. "the ruach hakodesh". Spec 13.3.';

ALTER TABLE lexicon_terms ADD CONSTRAINT lexicon_terms_no_doubled_article
    CHECK (NOT has_doubled_hebrew_article(term));

-- `register` is an internal editing label and must never reach a reader-facing
-- surface (§7.5, critical constraint). Nothing in src/query/ selects it; this
-- comment is the reminder for whoever writes the admin console.
COMMENT ON COLUMN lexicon_terms.register IS
    'INTERNAL ONLY. Never exposed in the search UI, API responses, or any reader-facing surface (spec 7.5).';
