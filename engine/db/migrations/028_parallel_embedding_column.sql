-- 028 — the second embedding column, for §12.3 rolling model migration.
--
-- §12.3: "Roll a model change forward by embedding into a new model_id while the
-- old index keeps serving, evaluate, then cut over." A single `embedding` column
-- cannot do that. Re-embedding in place would leave the corpus half in one
-- vector space and half in another for the length of the backfill, and cosine
-- between two model spaces is not a smaller number — it is a meaningless one.
--
-- So the candidate model gets its own column and its own indexes. Nothing reads
-- `embedding_next` until an evaluation says to, and the cutover is then a rename
-- rather than a re-computation. If the candidate loses, the column is dropped
-- and no serving path ever saw it.
--
-- The risk register calls this out directly: "Embedding model changed mid-build,
-- forcing full reindex — mitigated by model_id per chunk making migration
-- rolling." This is the column that makes it rolling.

ALTER TABLE chunks
    ADD COLUMN embedding_next     halfvec(1024),
    ADD COLUMN model_id_next      TEXT,
    ADD COLUMN embedded_next_at   TIMESTAMPTZ,
    ADD COLUMN embed_next_attempts SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN embed_next_error   TEXT;

COMMENT ON COLUMN chunks.embedding_next IS
    'Candidate model vectors during a 12.3 rolling migration. NULL outside one. Never read by search until cutover.';

-- Mirrors the partial indexes on `embedding` exactly (011). Built now rather
-- than after the backfill: on this corpus the build is seconds, and an index
-- created later is one more step to forget on the day of a cutover.
CREATE INDEX chunks_embedding_next_zone_a ON chunks
    USING hnsw (embedding_next halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE tier = 'T1';

CREATE INDEX chunks_embedding_next_zone_b ON chunks
    USING hnsw (embedding_next halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE tier IN ('T2','T3');

-- Backfill progress, so a half-finished migration is visible without knowing
-- which columns to look at.
CREATE VIEW embedding_migration AS
SELECT
    model_id                                        AS live_model,
    model_id_next                                   AS candidate_model,
    count(*)::bigint                                AS chunks,
    count(embedding)::bigint                        AS live_embedded,
    count(embedding_next)::bigint                   AS candidate_embedded,
    count(*) FILTER (WHERE embedding IS NOT NULL
                       AND embedding_next IS NULL)::bigint AS candidate_backlog
FROM chunks
GROUP BY model_id, model_id_next;

COMMENT ON VIEW embedding_migration IS
    'Progress of a 12.3 rolling embedding migration. candidate_backlog = 0 means the candidate is ready to evaluate.';
