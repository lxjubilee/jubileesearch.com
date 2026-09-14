-- 032 — correct the database COMMENT on zone_a_relevance_floor.
--
-- Migration 026 wrote a COMMENT describing the floor as 0.0080 with 35 measured
-- negatives. Two things have since made it wrong, and a COMMENT is what someone
-- reads from `\d+ ranking_config` when they have no reason to open a migration:
--
--   1. 026 was already wrong when it ran. At its own position the value was
--      0.0150, seeded by 022; 027 set 0.0080 afterwards. That is the original
--      config-drift defect, and `npm test` names 026 as a known-wrong migration
--      rather than pretending otherwise.
--   2. 030 re-derived the floor from the bge-m3 distribution: 0.011027, against
--      36 negatives rather than 35.
--
-- 026 itself is not edited. It is history, and rewriting its prose would destroy
-- the record that the defect happened — which is the record that justifies the
-- test. A correction belongs in a new migration, which is this one.

COMMENT ON COLUMN ranking_config.value IS
    'Runtime ranking parameter. Changing one through /api/v1/admin/ranking is audited and revertible, but writes to ONE database: a value that must survive a deployment needs a migration. npm test prints a migrations-vs-database comparison for every zone_a_* key on every run.';

UPDATE ranking_config
   SET description = 'Minimum fused score for a Zone A result. CURRENTLY A NO-OP BY DECISION: at 0.011027 all 36 measured negative queries are admitted. Measured under two independent embedders (MiniLM, then bge-m3), the wanted and negative score ranges are the same range — 0.0110..0.0422 against 0.0114..0.0421 — so this is structural, not a property of either model. RRF is rank-derived and carries no magnitude; neither pre-fusion arm can gate either, because they are complementary. Recall-first by decision. The working gate is zone_a_cross_encoder_floor, awaiting the specified cross-encoder. See migration 030 for the curve and eval/derive-thresholds.mjs for the derivation.'
 WHERE key = 'zone_a_relevance_floor';
