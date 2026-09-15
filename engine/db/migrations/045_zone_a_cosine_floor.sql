-- 045 — a relevance gate for Zone A that does not need the cross-encoder.
--
-- With the reranker off (OPEN-ITEMS 23, CPU deployment) nothing stood between
-- an off-topic query and a Zone A block: "who is michael jackson" showed two
-- pages because "michael" matched the archangel and the fused score cleared
-- the relevance floor. RRF scores are not relevance -- both arms always return
-- something. The gate in coverage.js (vectorGate) empties Zone A unless one of
-- the top five has a chunk cosine at or above this floor, or matched every
-- original term. Calibrated on the gold set 2026-09-15: 0.68 empties 12 of
-- 17 off-topic queries and loses none of 95 positives (eval/gate-calibrate.mjs).

INSERT INTO ranking_config (key, value, description) VALUES
  ('zone_a_cosine_floor', 0.68,
   'Zone A is emptied unless one of the top five candidates has a best-chunk cosine at or above this, or matched every original query term (strict lexical). Used when the cross-encoder gate did not run. 0 = off.')
ON CONFLICT (key) DO NOTHING;
