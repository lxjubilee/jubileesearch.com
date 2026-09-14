-- 031 — drop the retired MiniLM vectors. The §12.3 rolling migration closes.
--
-- Gate passed before running this: the gold set was re-scored against the LIVE
-- column after the cutover and after the thresholds were re-derived
-- (eval/results/bge-m3-live.json). It reproduced the candidate run exactly --
-- R@10 57.6 hybrid / 47.1 lexical / 55.3 semantic, MRR 0.3960 -- and the drift
-- guard confirmed the harness still agrees with search(). Nothing about the
-- cutover changed a result, which is what "confirmed" has to mean before
-- deleting the only way back.
--
-- What is being given up: the ability to reverse 029 by renaming the columns
-- back. From here a rollback means re-embedding under MiniLM, which is ~4.6
-- hours on the current CPU stand-in. That is the trade, taken deliberately --
-- 5,644 zero-padded 384-dim vectors and a 30.8 MB HNSW graph are not free, and
-- at network scale the same column would be ~2 GB of vectors nothing reads.
--
-- ORDER MATTERS, and the first attempt at this migration got it wrong:
-- `embedding_migration` selects the columns being dropped, so DROP COLUMN fails
-- with "other objects depend on it" unless the view goes FIRST. The whole
-- migration then rolled back, which is the behaviour to want -- but the fix is
-- ordering, not CASCADE. `DROP COLUMN ... CASCADE` would have succeeded by
-- silently taking the view with it, leaving a dependency destroyed rather than
-- rebuilt.
DROP VIEW IF EXISTS embedding_migration;

DROP INDEX IF EXISTS chunks_embedding_prev_zone_a;
DROP INDEX IF EXISTS chunks_embedding_prev_zone_b;

ALTER TABLE chunks
    DROP COLUMN embedding_prev,
    DROP COLUMN model_id_prev,
    DROP COLUMN embedded_prev_at,
    DROP COLUMN embed_prev_attempts,
    DROP COLUMN embed_prev_error;

-- Rebuilt around a single model. A future rolling migration adds its own spare
-- column and its own version of this view; it does not inherit one shaped for two.

CREATE VIEW embedding_migration AS
SELECT
    model_id                                          AS live_model,
    count(*)::bigint                                  AS chunks,
    count(embedding)::bigint                          AS live_embedded,
    count(*) FILTER (WHERE embedding IS NULL)::bigint AS live_backlog
FROM chunks
GROUP BY model_id;

COMMENT ON VIEW embedding_migration IS
    'State of the embedding column. More than one row means a model migration is in progress or was left unfinished.';

-- Not an index-version bump. Nothing a reader can observe changes here: the
-- ranking already moved in 029 and 030, and this only removes storage. Bumping
-- would throw away a warm result cache for no reason.
