# Operations: backups and restore

Spec §16: "Nightly full plus WAL archiving. Unlogged cache tables excluded.
Restore drill quarterly, documented." Acceptance 28: "A full restore from
backup into a clean environment is performed and documented."

Files here are installed on the Contabo box (13.140.33.98) under
`/var/www/jubileesearch/engine/ops/`; the systemd units are copied to
`/etc/systemd/system/`.

| file | what |
| --- | --- |
| `backup.sh` | nightly: `pg_dump -Fc` (cache tables schema-only), `pg_dumpall -g`, `pg_basebackup` (tar, gzip), config + secrets tarball; retention 14 dumps / 7 base backups / WAL back to the oldest base |
| `restore-drill.sh` | restores the newest dump into `jubileesearch_drill`, compares row counts with live, checks HNSW indexes and extensions, runs two searches through the engine against it, drops it |
| `jubileesearch-backup.service/.timer` | runs `backup.sh` daily at 00:30 |

Backups land in `/var/backups/jubileesearch/{dump,base,wal,config}` (mode
700; the config tarballs are 600 because they carry the `.env` secrets). They
are on the same disk as the database. Copying `dump/` and `config/` off the
box nightly is the one step not done here: it needs a destination, which is
a hosting decision (D8). Until then a disk failure loses both.

## WAL archiving

`postgresql.conf` (17/main) carries:

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/backups/jubileesearch/wal/%f && cp %p /var/backups/jubileesearch/wal/%f'
archive_timeout = 300
```

`archive_timeout` forces a WAL switch every five minutes on a quiet database,
so the archive is never more than five minutes behind. `pg_stat_archiver`
shows whether it is keeping up:

```sql
SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal FROM pg_stat_archiver;
```

## Restoring

**Logical, into a clean database (what the drill does):**

```sh
sudo -u postgres psql -f /var/backups/jubileesearch/dump/globals-<stamp>.sql   # roles, on a new cluster only
sudo -u postgres createdb -O jubileesearch jubileesearch
sudo -u postgres psql -d jubileesearch -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent'
sudo -u postgres pg_restore -d jubileesearch -j 2 --no-owner --no-comments --role=jubileesearch /var/backups/jubileesearch/dump/jubileesearch-<stamp>.dump
```

The extensions are created first, by the superuser: pgvector is not a
trusted extension, so the `CREATE EXTENSION` inside the dump fails under
`--role=jubileesearch`, and pg_restore then skips every object that needs
`halfvec` -- the chunks table, both HNSW indexes, the embedding cache -- while
still exiting 0 for everything else. The first drill (2026-09-15) found this.
The cache tables come back empty, which is their normal state after any
restart. `bump_index_version` is not needed: `index_version` is restored.

**Point in time, from base + WAL:**

```sh
systemctl stop postgresql
mv /var/lib/postgresql/17/main /var/lib/postgresql/17/main.broken
mkdir /var/lib/postgresql/17/main && cd /var/lib/postgresql/17/main
tar -xzf /var/backups/jubileesearch/base/<stamp>/base.tar.gz
chown -R postgres:postgres . && chmod 700 .
cat > postgresql.auto.conf <<EOF
restore_command = 'cp /var/backups/jubileesearch/wal/%f %p'
recovery_target_time = '2026-09-15 12:00:00+02'   # or omit for "everything archived"
EOF
touch recovery.signal
systemctl start postgresql
```

Postgres replays WAL to the target and promotes itself. The base tarball was
taken with `-Xnone`, so the WAL directory must hold every segment from the
one named in its `backup_label` onward; `backup.sh`'s retention keeps exactly
that range.

**Config and secrets:** `tar -xzf config/config-<stamp>.tar.gz -C /` puts the
three `.env` files, the nginx site and the systemd units back where they were.

## The drill

Run `ops/restore-drill.sh` and paste its output into `docs/RESTORE-DRILL.md`
with the date. Quarterly, per the spec; also after any Postgres major upgrade
or a change to how backups are taken.
