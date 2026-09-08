-- 021 — position-bias seed curve (R7, Appendix A.3).
--
-- "seeded with a reasonable decay curve and later re-estimated from real data
-- once traffic supports it. Seeding it is fine; leaving it unmeasured forever
-- is not."
--
-- examination_prob is P(user looked at this slot at all), which is what the
-- corrected CTR divides by. Two things shape the curve here:
--
--   * Zone A is the top block, so slot A1 is the reference point at 1.0.
--   * Zone B always renders *beneath* Zone A (§13.5, acceptance 12), so its
--     first slot is already well down the page. Starting Zone B at 1.0 would
--     be the classic mistake -- it would make Zone B results look far worse
--     than they are, and would bias the click loop against the wider web
--     permanently.
--
-- jobs/estimate-position-bias.mjs replaces these from logged data once there
-- are enough eligible swaps to estimate from.

INSERT INTO position_bias (zone, position, examination_prob) VALUES
    ('A', 1, 1.0000), ('A', 2, 0.6800), ('A', 3, 0.5000),
    ('A', 4, 0.3900), ('A', 5, 0.3100),
    ('B', 1, 0.5500), ('B', 2, 0.4000), ('B', 3, 0.3100),
    ('B', 4, 0.2500), ('B', 5, 0.2100), ('B', 6, 0.1800),
    ('B', 7, 0.1550), ('B', 8, 0.1350), ('B', 9, 0.1200),
    ('B',10, 0.1050)
ON CONFLICT (zone, position) DO NOTHING;   -- never clobber a measured curve
