-- 044 — fusion arm guarantee, and the concepts the gold set showed missing.
--
-- Reciprocal-rank fusion with k = 60 values "first in one arm" (1/61) the
-- same as "about sixtieth in both" (2/120). With 100 candidates an arm, the
-- fifty pages the reranker sees can all be middling in both arms while the
-- page the lexical arm put first is left out -- gold X13 ("Adonai and a room
-- held on thirty days notice") was lexical #1 and never reached the
-- reranker. Retrieval now always carries the top N of each arm into the
-- rerank set, on top of the fifty best fused (retrieval.js).

INSERT INTO ranking_config (key, value, description) VALUES
  ('fusion_arm_guarantee', 10,
   'The top N pages of each retrieval arm (lexical, semantic) always enter the rerank candidate set, whatever their fused score. 0 = pure RRF order.')
ON CONFLICT (key) DO NOTHING;

-- Concepts. "Dry bones" and "the seal of the Spirit" are images a reader
-- searches by, in three languages, and neither had a concept, so the Romanian
-- cross-language pairs L01 and L02 had nothing to bridge on. Chiasm is a
-- Hebraic-insight term with three spellings. "Mishpakhah" is the spelling
-- the site itself uses in its category name and was not a term.

INSERT INTO lexicon_concepts (concept_key, gloss, notes) VALUES
  ('dry_bones', 'Ezekiel 37: the valley of dry bones, breath and the resurrection of a people', 'Migration 044, from gold-set misses L01/X01.'),
  ('seal_of_spirit', 'The believer sealed by the Spirit (Eph 1:13, 2 Cor 1:22): an identity that cannot be taken', 'Migration 044, from gold-set miss L02.'),
  ('chiasm', 'Chiastic structure in Hebrew writing: the main point sits in the middle', 'Migration 044, from gold-set miss T01.')
ON CONFLICT (concept_key) DO NOTHING;

WITH term_data(concept_key, term, lang, register, weight, is_primary) AS (VALUES
    ('dry_bones','dry bones','en','CCI',1.00,true),
    ('dry_bones','valley of dry bones','en','CCI',1.00,false),
    ('dry_bones','can these bones live','en','CCI',0.90,false),
    ('dry_bones','oase uscate','ro','CCI',1.00,false),
    ('dry_bones','oasele uscate','ro','CCI',1.00,false),
    ('dry_bones','valea oaselor','ro','CCI',0.95,false),
    ('dry_bones','सूखी हड्डियाँ','hi','CCI',1.00,false),
    ('seal_of_spirit','seal of the spirit','en','CCI',1.00,true),
    ('seal_of_spirit','sealed with the holy spirit','en','CCI',1.00,false),
    ('seal_of_spirit','sealed','en','CCI',0.70,false),
    ('seal_of_spirit','seal','en','CCI',0.60,false),
    ('seal_of_spirit','pecetea duhului','ro','CCI',1.00,false),
    ('seal_of_spirit','pecete','ro','CCI',0.80,false),
    ('seal_of_spirit','pecetea','ro','CCI',0.80,false),
    ('seal_of_spirit','pecetluit','ro','CCI',0.85,false),
    ('seal_of_spirit','मुहर','hi','CCI',0.90,false),
    ('chiasm','chiasm','en','OHI',1.00,true),
    ('chiasm','chiastic','en','OHI',0.95,false),
    ('chiasm','chiasmus','en','OHI',0.95,false),
    ('chiasm','chiastic structure','en','OHI',0.95,false),
    ('chiasm','chiasm','ro','OHI',1.00,false),
    ('mishpachah','mishpakhah','en','OHI',1.00,false)
)
INSERT INTO lexicon_terms (concept_id, term, lang, register, weight, is_primary)
SELECT c.id, t.term, t.lang, t.register, t.weight, t.is_primary
FROM term_data t JOIN lexicon_concepts c ON c.concept_key = t.concept_key
ON CONFLICT (term, lang, concept_id) DO NOTHING;

SELECT bump_index_version('migration 044: lexicon');
