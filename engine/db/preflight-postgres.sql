-- Does this Postgres instance meet what JubileeSearch's 32 migrations need?
--
--   psql "postgresql://USER@HOST:5432/postgres" -f db/preflight-postgres.sql
--
-- Run it against the SERVER (any database) before creating the app database.
-- Every row prints PASS or FAIL with the value found, so the output can be
-- pasted back verbatim. Nothing here writes anything.

\pset border 2
\echo '=============================================================='
\echo ' JubileeSearch — Postgres preflight'
\echo '=============================================================='

-- 1. Server version. Migration 002 uses halfvec, and the pgvector build that
--    provides it is not packaged for anything older than 16 in practice.
SELECT 'server version' AS check,
       current_setting('server_version') AS found,
       '16 or newer' AS required,
       CASE WHEN current_setting('server_version_num')::int >= 160000
            THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- 2. pgvector. THIS IS THE ONE THAT MATTERS MOST.
--    halfvec and halfvec_cosine_ops are 0.7.0 features. On 0.6.x migration 002
--    does not degrade -- it fails outright, and so does every later index.
SELECT 'pgvector available' AS check,
       COALESCE(default_version, 'NOT INSTALLED') AS found,
       '0.7.0 or newer' AS required,
       CASE WHEN default_version IS NULL THEN 'FAIL'
            WHEN string_to_array(default_version, '.')::int[] >= ARRAY[0,7,0]
            THEN 'PASS' ELSE 'FAIL' END AS verdict
  FROM pg_available_extensions WHERE name = 'vector'
UNION ALL
SELECT 'pgvector available', 'NOT INSTALLED', '0.7.0 or newer', 'FAIL'
 WHERE NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector');

-- 3. The other four extensions. All ship with postgresql-contrib; if any is
--    missing the package is not installed.
SELECT 'extension: ' || e.name AS check,
       COALESCE(a.default_version, 'NOT AVAILABLE') AS found,
       'any' AS required,
       CASE WHEN a.name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
  FROM (VALUES ('pg_trgm'), ('unaccent'), ('pgcrypto'), ('btree_gin')) AS e(name)
  LEFT JOIN pg_available_extensions a ON a.name = e.name;

-- 4. Text search configurations. ts_config_for() casts these to regconfig at
--    query time, so a missing one is a runtime error on a search, not a
--    migration failure -- which is the worse way to find out. `romanian` is the
--    live concern: pocaieste.com and pocaintasibotez.com are ro-RO.
SELECT 'ts config: ' || c.name AS check,
       CASE WHEN t.cfgname IS NULL THEN 'MISSING' ELSE 'present' END AS found,
       'built-in' AS required,
       CASE WHEN t.cfgname IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
  FROM (VALUES ('english'), ('romanian'), ('simple'), ('spanish'), ('french'),
               ('german'), ('portuguese'), ('italian'), ('dutch'), ('russian')) AS c(name)
  LEFT JOIN pg_ts_config t ON t.cfgname = c.name;

-- 5. Encoding. The corpus carries Romanian diacritics and Hebrew script.
SELECT 'server encoding' AS check,
       current_setting('server_encoding') AS found,
       'UTF8' AS required,
       CASE WHEN current_setting('server_encoding') = 'UTF8' THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- 6. Can the connecting role actually create extensions? CREATE EXTENSION needs
--    superuser for most of these. A role that can create a database but not an
--    extension fails on migration 001, which looks like a broken migration and
--    is a permissions problem.
SELECT 'role can create extensions' AS check,
       CASE WHEN rolsuper THEN 'superuser'
            WHEN pg_has_role(current_user, 'pg_maintain', 'MEMBER') THEN 'pg_maintain'
            ELSE 'ordinary role' END AS found,
       'superuser for migration 001' AS required,
       CASE WHEN rolsuper THEN 'PASS' ELSE 'CHECK' END AS verdict
  FROM pg_roles WHERE rolname = current_user;

-- 7. Memory settings that decide whether an HNSW build on 137k vectors finishes
--    in minutes or hours. Not a pass/fail -- these are what to raise before the
--    network import, not before this one.
SELECT 'setting: ' || name AS check, setting || COALESCE(unit, '') AS found,
       CASE name
         WHEN 'shared_buffers' THEN '8GB suggested at network scale'
         WHEN 'maintenance_work_mem' THEN '4GB suggested for HNSW builds'
         WHEN 'work_mem' THEN '64MB+'
         WHEN 'max_parallel_maintenance_workers' THEN '4+ for index builds'
         WHEN 'max_connections' THEN '100 is ample'
       END AS required,
       'INFO' AS verdict
  FROM pg_settings
 WHERE name IN ('shared_buffers', 'maintenance_work_mem', 'work_mem',
                'max_parallel_maintenance_workers', 'max_connections')
 ORDER BY name;

\echo ''
\echo 'After creating the extension, confirm halfvec and hnsw actually exist:'
\echo '  CREATE EXTENSION IF NOT EXISTS vector;'
\echo "  SELECT typname FROM pg_type WHERE typname IN ('vector','halfvec');"
\echo "  SELECT amname FROM pg_am WHERE amname = 'hnsw';"
\echo "  SELECT opcname FROM pg_opclass WHERE opcname = 'halfvec_cosine_ops';"
\echo ''
