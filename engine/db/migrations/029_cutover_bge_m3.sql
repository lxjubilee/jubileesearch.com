-- 029 — cut the query path over to bge-m3. The §12.3 rolling migration lands.
--
-- The candidate column has been backfilled (5,644/5,644, zero failures) and
-- evaluated against the 85-pair gold set with the reranker held constant. bge-m3
-- leads on R@1, R@5, R@10 and MRR. The deltas are small — see the note below on
-- what one pair is worth — and the decision does not rest on them:
--
--   * §6.1 specifies bge-m3. MiniLM was a stand-in adopted without checking
--     whether the specified model could run locally. It could.
--   * bge-m3 is natively 1024-dimensional. MiniLM is 384, zero-padded to 1024,
--     so 640 of every stored dimension were structurally empty.
--   * MiniLM is English-only. The network import brings 168 Romanian articles
--     (pocaieste.com, pocaintasibotez.com), and acceptance criterion 9 cannot be
--     met by a monolingual encoder at any score.
--
-- SWAP, DO NOT DROP. The MiniLM vectors are renamed aside, not deleted, so the
-- cutover is reversible by running the renames in the other direction. They are
-- dropped in a later migration, once the gold set has confirmed the live column.

-- The view is dropped and recreated rather than left to follow the renames.
-- Postgres resolves view columns by attribute number, so a rename does not
-- rewrite the view's meaning -- `model_id AS live_model` would silently keep
-- pointing at the OLD column and the view would report the migration backwards.
DROP VIEW IF EXISTS embedding_migration;

ALTER TABLE chunks RENAME COLUMN embedding           TO embedding_prev;
ALTER TABLE chunks RENAME COLUMN model_id            TO model_id_prev;
ALTER TABLE chunks RENAME COLUMN embedded_at         TO embedded_prev_at;
ALTER TABLE chunks RENAME COLUMN embed_attempts      TO embed_prev_attempts;
ALTER TABLE chunks RENAME COLUMN embed_error         TO embed_prev_error;

ALTER TABLE chunks RENAME COLUMN embedding_next      TO embedding;
ALTER TABLE chunks RENAME COLUMN model_id_next       TO model_id;
ALTER TABLE chunks RENAME COLUMN embedded_next_at    TO embedded_at;
ALTER TABLE chunks RENAME COLUMN embed_next_attempts TO embed_attempts;
ALTER TABLE chunks RENAME COLUMN embed_next_error    TO embed_error;

-- Indexes follow their column through a rename, but their NAMES do not. Left
-- alone, `chunks_embedding_zone_a` would be the index on the retired column --
-- true but unreadable, and the next person to tune the ANN scan would look at
-- the wrong one.
ALTER INDEX chunks_embedding_zone_a      RENAME TO chunks_embedding_prev_zone_a;
ALTER INDEX chunks_embedding_zone_b      RENAME TO chunks_embedding_prev_zone_b;
ALTER INDEX chunks_embedding_next_zone_a RENAME TO chunks_embedding_zone_a;
ALTER INDEX chunks_embedding_next_zone_b RENAME TO chunks_embedding_zone_b;

COMMENT ON COLUMN chunks.embedding IS
    'Live vectors, bge-m3, native 1024-dim. Read by search.';
COMMENT ON COLUMN chunks.embedding_prev IS
    'Retired MiniLM vectors, 384-dim zero-padded to 1024. Read by nothing. Kept only so the cutover is reversible; dropped in a later migration.';

CREATE VIEW embedding_migration AS
SELECT
    model_id                                        AS live_model,
    model_id_prev                                   AS previous_model,
    count(*)::bigint                                AS chunks,
    count(embedding)::bigint                        AS live_embedded,
    count(embedding_prev)::bigint                   AS previous_embedded,
    count(*) FILTER (WHERE embedding IS NULL)::bigint AS live_backlog
FROM chunks
GROUP BY model_id, model_id_prev;

COMMENT ON VIEW embedding_migration IS
    'State of the embedding columns. live_backlog = 0 means every chunk is embedded under the live model.';

-- §13.7: the result cache is keyed on the index version, so every cached payload
-- built against MiniLM vectors is now stale. Bumping invalidates them in one
-- statement rather than leaving the first readers after a cutover to be served
-- the previous model's ranking.
SELECT bump_index_version('migration:029-cutover-bge-m3');
