# Restore drill

Spec §16: "Restore drill quarterly, documented." Acceptance 28: "A full restore
from backup into a clean environment is performed and documented." The
procedure is `engine/ops/restore-drill.sh`; the backup it restores is taken by
`engine/ops/backup.sh` (nightly, `jubileesearch-backup.timer`). Both are
described in `engine/ops/README.md`.

Next drill due: **December 2026**.

## 2026-09-15 — first drill

Environment: the production Contabo box (13.140.33.98), Postgres 17.11, pgvector
0.8.6. Clean environment = a new database `jubileesearch_drill` on the same
cluster, created empty and populated only from the dump file. The live
database was not touched; the engine kept serving throughout.

Backup restored: the first nightly-format backup, taken 12:20 that day (the
timer's first scheduled run was 00:30 the next morning). Dump 118 MB,
`pg_dump -Fc -Z 6` with the three unlogged cache tables schema-only.

**First attempt failed, usefully.** `pg_restore --role=jubileesearch` ran the
dump's `CREATE EXTENSION vector` as the application role, which is not a
superuser, so the extension was not created and pg_restore skipped every
object that needs the `halfvec` type: the `chunks` table, both HNSW indexes,
the embedding cache. Every other table restored and the script's row-count
check reported `chunks n/a`. The fix -- create `vector`, `pg_trgm` and
`unaccent` as `postgres` before running pg_restore -- is now in the script and
in the README's manual procedure. This is the kind of thing a drill exists to
find; a restore under pressure would have produced a database that answered
searches with no vector arm.

**Second attempt, verbatim output:**

```
== restore drill 2026-09-15T12:23:12+02:00
dump: /var/backups/jubileesearch/dump/jubileesearch-20260915-1220.dump (118M, written 2026-09-15T12:21:20+02:00)
2026-09-15T12:23:13+02:00 pg_restore into jubileesearch_drill
pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_trgm
Command was: COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


pg_restore: error: could not execute query: ERROR:  must be owner of extension unaccent
Command was: COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


pg_restore: error: could not execute query: ERROR:  must be owner of extension vector
Command was: COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


2026-09-15T12:23:37+02:00 restored in 24s

== row counts (live vs restored)
  table                          live     restored
  domains                          58           58 ok
  pages                          2257         2257 ok
  chunks                        12865        12865 ok
  lexicon_concepts                 46           46 ok
  lexicon_terms                   390          390 ok
  best_bets                         0            0 ok
  users                             4            4 ok
  search_queries                23606        23606 ok
  result_impressions            76320        76320 ok
  blocklist_entries           5057199      5057199 ok
  (result_cache / embedding_cache / webhook_nonces are schema-only by design)

== structure
  migrations applied: 43  (live: 43)
  index_version:      52
  embedded chunks:    12865
  hnsw indexes:       2
  extensions:         vector 0.8.6, pg_trgm 1.6, unaccent 1.1

== a search against the restored database (engine code, PGDATABASE=jubileesearch_drill)
  ruach hakodesh: coverage moderate, 3 results, 1267 ms
      - You Are Allowed to Unpack
      - Zev Inspire — Sonic Craft v3.0 Executive Summary
  why do people stop showing up after the crisis passes: coverage moderate, 3 results, 994 ms
      - The Tray Of Tablets On The Windowsill
      - Awake for No Reason I Can Name

== drill database dropped
```

(The three `COMMENT ON EXTENSION` errors are pg_restore trying to re-comment
extensions it did not create; harmless, and `--no-comments` now suppresses
them.)

What the output shows: every table matches the live row count, including 5.06
million blocklist rows; all 43 migrations present; 12,865 of 12,865 chunks
carry their embedding; both partial HNSW indexes exist; the engine's own
`search()` runs hybrid retrieval and the cross-encoder against the restored
database and returns the same results as live. Restore time 24 s for 1.8 GB of
database, two parallel jobs.

Not covered by this drill: point-in-time recovery from `base/` + `wal/`
(procedure in the README, untested), and restoring onto a different machine
(no second machine; see OPEN-ITEMS §22).
