-- Run INSIDE the jubileesearch database, as the APP role, after setup.
--
--   psql "postgresql://jubileesearch:PASSWORD@HOST:5432/jubileesearch" \
--        -f engine/db/preflight-database.sql
--
-- The server preflight (preflight-postgres.sql) answers "can this server host
-- it". This answers "is the database ready and can the app role actually use
-- it", which is a different question and the one that fails at 3am.

\pset border 2
\echo '=============================================================='
\echo ' JubileeSearch — database preflight (run as the APP role)'
\echo '=============================================================='

-- 1. The five extensions, installed IN THIS DATABASE. Extensions are per
--    database, not per server: created in `postgres` and not here, every
--    migration still fails.
SELECT 'extension: ' || e.name AS check,
       COALESCE(x.extversion, 'NOT INSTALLED') AS found,
       CASE WHEN x.extname IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
  FROM (VALUES ('vector'), ('pg_trgm'), ('unaccent'), ('pgcrypto'), ('btree_gin')) AS e(name)
  LEFT JOIN pg_extension x ON x.extname = e.name;

-- 2. halfvec, hnsw and the operator class the indexes name. Present only on
--    pgvector 0.7+; on 0.6 the extension installs happily and migration 002 then
--    fails on a type that does not exist.
SELECT 'type halfvec' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_type WHERE typname = 'halfvec')
            THEN 'present' ELSE 'MISSING' END AS found,
       CASE WHEN EXISTS (SELECT 1 FROM pg_type WHERE typname = 'halfvec')
            THEN 'PASS' ELSE 'FAIL — pgvector is older than 0.7' END AS verdict
UNION ALL
SELECT 'access method hnsw',
       CASE WHEN EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') THEN 'present' ELSE 'MISSING' END,
       CASE WHEN EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'opclass halfvec_cosine_ops',
       CASE WHEN EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'halfvec_cosine_ops') THEN 'present' ELSE 'MISSING' END,
       CASE WHEN EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'halfvec_cosine_ops') THEN 'PASS' ELSE 'FAIL' END;

-- 3. CAN THIS ROLE CREATE TABLES? The one most likely to bite on 16.
--
--    PostgreSQL 15 removed the default CREATE privilege on schema `public` for
--    every role except the database owner. So a perfectly sensible setup --
--    create the database as postgres, create an app role, hand over the password
--    -- produces a role that connects fine, reads fine, and cannot create a
--    table. Migration 002 then fails with "permission denied for schema public",
--    which reads like a broken migration and is a grant.
SELECT 'role can create in schema public' AS check,
       current_user || ' on ' || current_database() AS found,
       CASE WHEN has_schema_privilege(current_user, 'public', 'CREATE')
            THEN 'PASS' ELSE 'FAIL — needs OWNER of the database, or GRANT CREATE ON SCHEMA public' END AS verdict;

SELECT 'database owner' AS check,
       pg_get_userbyid(datdba) AS found,
       CASE WHEN pg_get_userbyid(datdba) = current_user
            THEN 'PASS — app role owns it' ELSE 'CHECK — owned by another role' END AS verdict
  FROM pg_database WHERE datname = current_database();

-- 4. Encoding and collation, for Romanian diacritics and Hebrew script.
SELECT 'encoding' AS check, pg_encoding_to_char(encoding) AS found,
       CASE WHEN pg_encoding_to_char(encoding) = 'UTF8' THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM pg_database WHERE datname = current_database();

-- 5. A real round trip through the vector path, so this is not a claim about
--    catalogues but a demonstration. Temporary: gone when the session ends.
CREATE TEMP TABLE _preflight_vec (id int, v halfvec(1024));
INSERT INTO _preflight_vec
SELECT 1, (SELECT ('[' || string_agg('0.01', ',') || ']')::halfvec(1024) FROM generate_series(1, 1024));
SELECT 'halfvec insert + cosine distance' AS check,
       round((v <=> v)::numeric, 6)::text AS found,
       CASE WHEN (v <=> v) < 0.000001 THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM _preflight_vec;

\echo ''
\echo 'All PASS means: npm run migrate will apply all 32 migrations.'
\echo ''
