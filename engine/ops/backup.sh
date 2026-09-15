#!/usr/bin/env bash
# Nightly backup of JubileeSearch (spec §16 "Backups: nightly full plus WAL
# archiving. Unlogged cache tables excluded.").
#
# Three things are written under $BACKUP_ROOT (default /var/backups/jubileesearch):
#
#   dump/jubileesearch-YYYYmmdd-HHMM.dump   pg_dump, custom format, compressed.
#                                            The unlogged tables (result_cache,
#                                            embedding_cache, webhook_nonces) are
#                                            dumped as schema only: their contents
#                                            are disposable by design (migration
#                                            008) and would only slow a restore.
#   dump/globals-YYYYmmdd-HHMM.sql           roles and grants (pg_dumpall -g), so a
#                                            restore into a clean cluster can
#                                            recreate the jubileesearch role.
#   base/YYYYmmdd-HHMM/                      pg_basebackup (tar, gzip) -- the base
#                                            for point-in-time recovery with the
#                                            WAL files postgres archives into wal/.
#   config/config-YYYYmmdd-HHMM.tar.gz       the three .env files, the nginx site,
#                                            the systemd units and the postgres
#                                            conf. Mode 0600: it holds secrets.
#
# Retention: DUMP_KEEP dumps (14), BASE_KEEP base backups (7), and WAL older
# than the oldest kept base backup (pg_archivecleanup). Run as root; pg_dump
# and pg_basebackup run as the postgres user over the local socket.
#
# Restore: see restore-drill.sh for the logical restore, and ops/README.md for
# point-in-time recovery from base/ + wal/.

set -euo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/var/backups/jubileesearch}
DB=${PGDATABASE:-jubileesearch}
DUMP_KEEP=${DUMP_KEEP:-14}
BASE_KEEP=${BASE_KEEP:-7}
STAMP=$(date +%Y%m%d-%H%M)
APP=/var/www/jubileesearch

mkdir -p "$BACKUP_ROOT"/{dump,base,wal,config}
chown postgres:postgres "$BACKUP_ROOT/wal" "$BACKUP_ROOT/base"
chmod 700 "$BACKUP_ROOT"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
t0=$(date +%s)

# --- logical dump ------------------------------------------------------------
log "pg_dump $DB"
sudo -u postgres pg_dump -Fc -Z 6 \
  --exclude-table-data=result_cache \
  --exclude-table-data=embedding_cache \
  --exclude-table-data=webhook_nonces \
  -f "/tmp/jubileesearch-$STAMP.dump" "$DB"
mv "/tmp/jubileesearch-$STAMP.dump" "$BACKUP_ROOT/dump/"
sudo -u postgres pg_dumpall -g > "$BACKUP_ROOT/dump/globals-$STAMP.sql"
chmod 600 "$BACKUP_ROOT"/dump/*-"$STAMP".*

# --- physical base backup (for PITR with wal/) --------------------------------
log "pg_basebackup"
sudo -u postgres pg_basebackup -D "$BACKUP_ROOT/base/$STAMP" -Ft -z -Xnone -c fast -P 2>&1 | tail -1
# -Xnone: the WAL needed to make this base consistent is in wal/ already
# (archive_mode=on), so it is not duplicated inside the tarball.

# --- config and secrets --------------------------------------------------------
log "config"
tar -czf "$BACKUP_ROOT/config/config-$STAMP.tar.gz" \
  --ignore-failed-read \
  "$APP/engine/.env" "$APP/web/.env.local" "$APP/engine/InferenceAPI/.env" \
  /etc/nginx/sites-available/jubileesearch \
  /etc/systemd/system/jubileesearch-*.service /etc/systemd/system/jubileesearch-*.timer \
  /etc/postgresql/17/main/postgresql.conf /etc/postgresql/17/main/pg_hba.conf \
  2>/dev/null
chmod 600 "$BACKUP_ROOT/config/config-$STAMP.tar.gz"

# --- retention ---------------------------------------------------------------
ls -1t "$BACKUP_ROOT"/dump/jubileesearch-*.dump | tail -n +$((DUMP_KEEP + 1)) | xargs -r rm -f
ls -1t "$BACKUP_ROOT"/dump/globals-*.sql          | tail -n +$((DUMP_KEEP + 1)) | xargs -r rm -f
ls -1t "$BACKUP_ROOT"/config/config-*.tar.gz      | tail -n +$((DUMP_KEEP + 1)) | xargs -r rm -f
ls -1dt "$BACKUP_ROOT"/base/*/                    | tail -n +$((BASE_KEEP + 1)) | xargs -r rm -rf

# WAL: keep everything from the oldest surviving base backup onward. The
# backup_label inside its base.tar.gz names the first WAL file it needs.
oldest=$(ls -1d "$BACKUP_ROOT"/base/*/ | sort | head -1)
if [ -n "$oldest" ] && [ -f "$oldest/base.tar.gz" ]; then
  first_wal=$(tar -xzOf "$oldest/base.tar.gz" backup_label 2>/dev/null | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]*\)).*/\1/p')
  if [ -n "$first_wal" ]; then
    sudo -u postgres pg_archivecleanup "$BACKUP_ROOT/wal" "$first_wal"
  fi
fi

# --- report ------------------------------------------------------------------
log "done in $(( $(date +%s) - t0 ))s"
du -sh "$BACKUP_ROOT"/dump "$BACKUP_ROOT"/base "$BACKUP_ROOT"/wal "$BACKUP_ROOT"/config | sed 's/^/  /'
ls -la "$BACKUP_ROOT/dump/jubileesearch-$STAMP.dump" | sed 's/^/  /'
