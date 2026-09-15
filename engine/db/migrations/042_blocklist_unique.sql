-- 042 — one row per (source, match_type, pattern) in blocklist_entries.
--
-- The loader is about to stream lists of several million hosts (UT1 adult is
-- 4.6M) straight into the table without holding them in memory, so it can no
-- longer de-duplicate in the process. The unique index does that instead
-- (ON CONFLICT DO NOTHING), and it is also the index gate 1 now reads: a host
-- and its parent domains are looked up in one query rather than scanned in a
-- JavaScript array (gates.js loadRules).

DELETE FROM blocklist_entries a
 USING blocklist_entries b
 WHERE a.id > b.id
   AND a.source IS NOT DISTINCT FROM b.source
   AND a.match_type = b.match_type
   AND a.pattern = b.pattern;

CREATE UNIQUE INDEX IF NOT EXISTS blocklist_entries_source_pattern_uidx
  ON blocklist_entries (source, match_type, pattern);
