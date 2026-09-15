-- 043 — hard-list terms for weapons sales and self-harm (§11.1 gate 2).
--
-- The gate-2 term list is meant to cover "adult content, gambling, drugs,
-- weapons sales, hate speech, and self-harm". The seed (migration 024) carried
-- weapons and self-harm only as soft terms, and the acceptance-20 run found a
-- ghost-gun listing that the classifier read as news. These phrases are the
-- vocabulary of a seller or a pro-suicide page and of nothing a ministry
-- site publishes, so they reject outright (severity 100). Terms that a news
-- report or a pastoral article could carry ("background check", "suicide")
-- are deliberately NOT here; those stay soft and route to review.

INSERT INTO blocklist_entries (pattern, match_type, category, source, severity) VALUES
  ('ghost gun kit',            'keyword', 'weapons',   'manual', 100),
  ('full-auto conversion',     'keyword', 'weapons',   'manual', 100),
  ('full auto conversion',     'keyword', 'weapons',   'manual', 100),
  ('auto sear',                'keyword', 'weapons',   'manual', 100),
  ('80% lower',                'keyword', 'weapons',   'manual', 100),
  ('untraceable firearm',      'keyword', 'weapons',   'manual', 100),
  ('no serial number',         'keyword', 'weapons',   'manual', 100),
  ('no background check',      'keyword', 'weapons',   'manual',  60),
  ('how to kill yourself',     'keyword', 'self-harm', 'manual', 100),
  ('painless ways to die',     'keyword', 'self-harm', 'manual', 100),
  ('pro-ana',                  'keyword', 'self-harm', 'manual', 100),
  ('thinspo',                  'keyword', 'self-harm', 'manual', 100)
ON CONFLICT DO NOTHING;
