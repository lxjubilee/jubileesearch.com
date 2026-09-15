-- 041 — the lexical arm matched a question only when EVERY word matched.
--
-- websearch_to_tsquery ANDs the terms, so "why do people stop showing up
-- after the crisis passes" needed one page containing stop, show, crisis and
-- pass, and the lexical arm returned nothing at all for most conversational
-- and paraphrase queries (eval: lex_rank null on 14 of 20 conversational
-- pairs). The vector arm carried them alone, and a page the vectors ranked
-- 20th had no second signal to lift it.
--
-- Retrieval now adds a third tsquery: the same lexemes OR'd, weighted by this
-- key. ts_rank_cd on an OR query rewards the page that matches more of the
-- terms, so it behaves as a soft AND: the strict match still scores highest
-- (it matches both queries), and a page with most of the words now enters the
-- candidate set instead of being invisible. 0 restores the old behaviour.

INSERT INTO ranking_config (key, value, description) VALUES
  ('lexical_any_weight', 0.30,
   'Weight of the any-term (OR) tsquery in the lexical arm, relative to the strict websearch query at 1.0. Lets a long natural-language query find pages that contain most but not all of its words. 0 = strict matching only.')
ON CONFLICT (key) DO NOTHING;
