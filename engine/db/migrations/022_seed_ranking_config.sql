-- 022 — runtime ranking configuration (§13.6, §13.5, §13.7).
-- Everything the ranker and the assembler read at request time, editable from
-- admin screen 9 without a deployment. Writing to this table bumps the index
-- version (trigger in 009), which invalidates the result cache atomically.

INSERT INTO ranking_config (key, value, description) VALUES
    -- §13.6 starting weights
    ('w_quality', 0.15, 'Zone A: quality_score multiplier'),
    ('w_engage',  0.20, 'Zone A: engagement_score from Jubilee Analytics (R8)'),
    ('w_ctr',     0.25, 'Both zones: bias-corrected CTR x confidence (R7). Set to 0 to disable the click loop at runtime.'),
    ('w_lang',    0.20, 'Both zones: query language matches page language'),
    ('w_fresh',   0.08, 'Both zones: freshness decay'),
    ('w_tier2',   0.10, 'Zone B: modest boost so approved faith-based sites lead'),
    ('w_safety',  0.05, 'Zone B: safety_score multiplier'),

    -- §13.5 coverage-aware Zone A sizing. "The floor is the discipline that
    -- makes this work." D10 recommends starting conservative with a high floor
    -- and tuning from real traffic after 30 days.
    ('zone_a_strong_threshold', 0.0400, 'Zone A top-result score at or above this shows 5 results'),
    ('zone_a_moderate_threshold', 0.0250, 'At or above this shows 3'),
    ('zone_a_weak_threshold',   0.0150, 'At or above this shows 2'),
    ('zone_a_relevance_floor',  0.0150, 'Below this Zone A shows 0 and renders the honest empty state'),
    ('zone_a_max_results',      5,      'Hard cap on Zone A size'),
    ('zone_b_max_results',     10,      'Zone B page size before pagination'),

    -- §13.5 host diversity
    ('zone_a_max_per_host', 3, 'Max results from one host in Zone A, first page'),
    ('zone_b_max_per_host', 2, 'Max results from one host in Zone B, first page'),

    -- §13.3
    ('lexicon_expansion_weight', 0.60, 'Default weight applied to expanded terms; original terms stay at 1.00'),

    -- §13.7 cache TTLs, in seconds
    ('cache_ttl_topical_s',      900, '15 minutes'),
    ('cache_ttl_navigational_s', 3600, '60 minutes for navigational and entity queries'),

    -- §13.10 runtime escape hatch: "If p95 breaches target under load, rerank
    -- Zone A only ... Make this a runtime switch, not a code change."
    ('rerank_zone_a', 1, '1 = rerank Zone A, 0 = fusion order only'),
    ('rerank_zone_b', 1, '1 = rerank Zone B, 0 = fusion order only. Drop this first under load.'),
    ('rerank_candidates', 50, 'Candidates passed to the cross-encoder per zone'),
    ('retrieval_candidates', 100, 'Lexical and semantic candidates fetched per zone before fusion'),
    ('rrf_k', 60, 'Reciprocal Rank Fusion constant'),

    -- §11.1 gate 3 thresholds, all runtime configurable
    ('safety_auto_index_confidence', 0.90, 'safe at or above this indexes into T3'),
    ('safety_review_confidence',     0.70, 'safe in [review, auto_index) goes to the human queue; below is rejected'),
    ('safety_domain_strike_limit',   5,    'Unsafe pages before a domain is auto-blocked and purged'),
    ('abuse_reports_to_suppress',    3,    'Reports on one page before automatic suppression (§11.3)')
ON CONFLICT (key) DO NOTHING;   -- never clobber a tuned production value

-- Freshness decay. §13.6 names `freshness_decay` as a factor but leaves its
-- shape open. Implemented as exp(-age_days / halflife), which is 1.0 for a page
-- published today and falls smoothly rather than stepping at an arbitrary
-- cutoff. A year is deliberately long: teaching content on this network does not
-- go stale the way news does, and w_fresh is the smallest weight in §13.6 (0.08)
-- for the same reason.
INSERT INTO ranking_config (key, value, description) VALUES
    ('freshness_halflife_days', 365, 'Half-life in days for the freshness decay factor')
ON CONFLICT (key) DO NOTHING;
