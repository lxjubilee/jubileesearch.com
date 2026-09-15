#!/usr/bin/env bash
# Restore drill (spec §16 "Restore drill quarterly, documented"; acceptance 28
# "A full restore from backup into a clean environment is performed and
# documented").
#
#   ops/restore-drill.sh [dump-file]        default: the newest dump
#
# Restores the logical dump into a NEW database, jubileesearch_drill, on this
# cluster -- a clean environment as far as the data is concerned: nothing in
# it comes from anywhere but the backup file. Then it proves the restore is
# usable, not just complete: row counts against the live database, the HNSW
# index present, a hybrid search executed by the engine's own code against the
# drill database. Drops the drill database at the end unless KEEP=1.
#
# Prints a report that goes into docs/RESTORE-DRILL.md. Run as root.

set -euo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/jubileesearch}
DUMP=${1:-$(ls -1t "$BACKUP_ROOT"/dump/jubileesearch-*.dump | head -1)}
DRILL=jubileesearch_drill
APP=/var/www/jubileesearch/engine

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
psqlq() { sudo -u postgres psql -At -d "$1" -c "$2"; }

echo "== restore drill $(date -Is)"
echo "dump: $DUMP ($(du -h "$DUMP" | cut -f1), written $(date -r "$DUMP" -Is))"

sudo -u postgres psql -At -c "DROP DATABASE IF EXISTS $DRILL" >/dev/null
sudo -u postgres psql -At -c "CREATE DATABASE $DRILL OWNER jubileesearch" >/dev/null
# The extensions must exist before the restore and must be created by a
# superuser: pgvector is not on the trusted list, so the CREATE EXTENSION
# inside the dump fails when it runs as the application role -- and without
# it the chunks table, both HNSW indexes and the embedding cache are silently
# skipped. Found by this drill on 2026-09-15.
sudo -u postgres psql -At -d "$DRILL" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;" >/dev/null

t0=$(date +%s)
log "pg_restore into $DRILL"
# --no-owner/--role: the dump carries ownership by jubileesearch; restoring as
# postgres and handing ownership over keeps the drill independent of who ran it.
sudo -u postgres pg_restore -d "$DRILL" -j 2 --no-owner --no-comments --role=jubileesearch "$DUMP" 2>&1 | grep -v "^pg_restore: warning" || true
t_restore=$(( $(date +%s) - t0 ))
log "restored in ${t_restore}s"

echo
echo "== row counts (live vs restored)"
printf '  %-22s %12s %12s\n' table live restored
for t in domains pages chunks lexicon_concepts lexicon_terms best_bets users search_queries result_impressions blocklist_entries; do
  live=$(psqlq jubileesearch "SELECT count(*) FROM $t" 2>/dev/null || echo n/a)
  rest=$(psqlq "$DRILL" "SELECT count(*) FROM $t" 2>/dev/null || echo n/a)
  printf '  %-22s %12s %12s %s\n' "$t" "$live" "$rest" "$([ "$live" = "$rest" ] && echo ok || echo DIFF)"
done
echo "  (result_cache / embedding_cache / webhook_nonces are schema-only by design)"

echo
echo "== structure"
echo "  migrations applied: $(psqlq "$DRILL" 'SELECT count(*) FROM schema_migrations')  (live: $(psqlq jubileesearch 'SELECT count(*) FROM schema_migrations'))"
echo "  index_version:      $(psqlq "$DRILL" 'SELECT version FROM index_version')"
echo "  embedded chunks:    $(psqlq "$DRILL" 'SELECT count(*) FROM chunks WHERE embedding IS NOT NULL')"
echo "  hnsw indexes:       $(psqlq "$DRILL" "SELECT count(*) FROM pg_indexes WHERE indexdef ILIKE '%hnsw%'")"
echo "  extensions:         $(psqlq "$DRILL" "SELECT string_agg(extname || ' ' || extversion, ', ') FROM pg_extension WHERE extname IN ('vector','pg_trgm','unaccent')")"

echo
echo "== a search against the restored database (engine code, PGDATABASE=$DRILL)"
cd "$APP"
sudo -u jubileesearch env PGDATABASE=$DRILL node --env-file=.env -e '
  const { search } = await import("./src/query/orchestrator.js");
  for (const q of ["ruach hakodesh", "why do people stop showing up after the crisis passes"]) {
    const t = performance.now();
    const r = await search({ q, zones: ["A"] });
    console.log(`  ${q}: coverage ${r.zone_a.coverage}, ${r.zone_a.results.length} results, ${Math.round(performance.now() - t)} ms`);
    for (const x of r.zone_a.results.slice(0, 2)) console.log(`      - ${x.title}`);
  }
  process.exit(0);
' 2>&1 | grep -v '"level":"info"'

if [ "${KEEP:-0}" != "1" ]; then
  sudo -u postgres psql -At -c "DROP DATABASE $DRILL" >/dev/null
  echo
  echo "== drill database dropped"
else
  echo
  echo "== drill database kept: $DRILL"
fi
