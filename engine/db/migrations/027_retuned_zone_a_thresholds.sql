-- 027 — the Zone A thresholds actually measured against the real corpus.
--
-- 022_seed_ranking_config seeded 0.0150 / 0.0250 / 0.0400. Those were chosen
-- before any content existed. The values below were derived from the observed
-- score distribution over the real 600-article JubileeVerse index, and the dev
-- database already carries them (set through /api/v1/admin/ranking, which is
-- audited). Without this migration a fresh deployment would seed 0.0150 while
-- migration 026's description said the value was 0.0080 -- a database whose
-- documentation contradicted its own configuration.
--
-- Observed wanted-query top scores, ascending:
--   0.0081 0.0100 0.0123 0.0137 0.0138 0.0146 0.0153 0.0174 0.0176 0.0243
--   0.0250 0.0273 0.0304 0.0326 0.0351 0.0370 0.0375 0.0406 0.0422 0.0422 0.0422
--
--   floor    0.0080  highest value that still returns a result for all 21
--   moderate 0.0180  lower tercile  -> 3 results
--   strong   0.0370  upper tercile  -> 5 results
--
-- The floor is a no-op at this value and that is a deliberate, recorded
-- decision, not an oversight -- see 026 for the curve and the objective.
-- Seeding it higher would silently trade away recall on a real corpus to make a
-- gate look like it works when the measurements say it cannot.

UPDATE ranking_config SET value = 0.0080 WHERE key = 'zone_a_relevance_floor';
UPDATE ranking_config SET value = 0.0180 WHERE key = 'zone_a_moderate_threshold';
UPDATE ranking_config SET value = 0.0370 WHERE key = 'zone_a_strong_threshold';
