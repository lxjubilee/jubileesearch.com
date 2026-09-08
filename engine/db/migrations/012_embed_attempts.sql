-- 012 — embedding retry bookkeeping.
--
-- §12.2: the embedding job "retries with backoff; after 3 failures marks the
-- chunk for manual inspection rather than silently dropping it". A chunk that
-- fails forever with no record of it is a hole in the vector index that nothing
-- reports: the page still matches lexically, so it looks present, and only a
-- recall test finds it missing. These two columns are what makes that visible.

ALTER TABLE chunks
    ADD COLUMN embed_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN embed_error    TEXT;

-- The job's claim query: unembedded, not yet exhausted, oldest first.
CREATE INDEX chunks_embed_pending_idx ON chunks (embed_attempts, id)
    WHERE embedded_at IS NULL AND embed_attempts < 3;

-- What the dashboard's "needs manual inspection" count reads.
CREATE INDEX chunks_embed_failed_idx ON chunks (page_id)
    WHERE embedded_at IS NULL AND embed_attempts >= 3;
