-- 039 — the vector arm was capped at 40 candidates by a Postgres default.
--
-- pgvector's HNSW scan returns at most `hnsw.ef_search` rows (default 40)
-- whatever the query's LIMIT says. Retrieval asks for retrieval_candidates * 3
-- chunks (300) and was quietly getting 40. It did not show while crawled pages
-- carried thirty near-identical chunks each -- a relevant page filled several of
-- the forty by itself -- and it showed the moment extraction was cleaned
-- (migration 038): four chunks a page, forty slots, and a cross-lingual target
-- that ranked first fell out of the candidate set entirely (OPEN-ITEMS §18).
--
-- Retrieval now sets the width per query (SET LOCAL, retrieval.js) from this
-- key, so it is tunable from the console like every other retrieval number.
-- Cost is linear in the width; 320 covers the 300 the query asks for.

INSERT INTO ranking_config (key, value, description) VALUES
  ('hnsw_ef_search', 320,
   'pgvector HNSW search width for the semantic arm (SET LOCAL hnsw.ef_search per query). Must be at least retrieval_candidates * 3 or the vector arm silently returns fewer candidates than asked; Postgres default is 40.')
ON CONFLICT (key) DO NOTHING;
