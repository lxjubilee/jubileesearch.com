-- 001 — extensions and the migration ledger.
--
-- Principle P3, "Postgres first": one database technology. Everything this
-- engine needs is an extension of this database, never a second server.
--
--   vector    >= 0.7 — halfvec(1024) for bge-m3. 0.7 is the floor, not a
--                      preference: halfvec does not exist before it (§6.1).
--   pg_trgm          — /suggest typeahead (§14) and fuzzy host matching.
--   unaccent         — query normalisation step [1] (§13.1).
--   pgcrypto         — digest() for content_hash / url_hash.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
DECLARE v text;
BEGIN
    SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
    IF string_to_array(v, '.')::int[] < ARRAY[0,7] THEN
        RAISE EXCEPTION
            'pgvector % is too old; halfvec(1024) needs >= 0.7 (spec 6.1)', v;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
