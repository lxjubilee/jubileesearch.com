-- ---------------------------------------------------------------------------
-- JubileeSearch — family-safety ruleset, bootstrap layer
--
-- POSTURE (chosen 2026-08-30): blocklist + heuristics for pages, default-deny
-- for media. A page from the open web is crawlable and becomes servable once it
-- clears the rules below; an image or video is NEVER servable until a
-- classifier has positively cleared it (that is enforced in the schema, not
-- here — media.safety_verdict defaults to 'unrated' and servable_media only
-- exposes 'safe').
--
-- WHAT THIS FILE IS NOT: it is not the blocklist. Hand-maintaining a list of
-- adult domains is a losing game — there are millions, and they rotate. The
-- bulk comes from the two public, redistributable category lists:
--
--   * UT1 (Université Toulouse 1 Capitole) — https://dsi.ut-capitole.fr/blacklists/
--     Categories to import as domain_block: adult, sexual_educational (review),
--     dating, gambling, drugs, violence, warez, phishing, malware.
--   * Shallalist — http://www.shallalist.de/  (porn, violence, gamble, drugs,
--     weapons, aggressive, anonvpn)
--
-- Import them with engine/bin/import-blocklists.js, which loads each category
-- as source='ut1:<category>' so a whole category can be switched off with one
-- UPDATE if it turns out to be too broad.
--
-- What IS here: the structural rules those lists cannot express — URL shapes,
-- the Jubilee estate's own always-allow, and the term rules that catch a page
-- on a domain nobody has categorised yet.
-- ---------------------------------------------------------------------------

-- ── 1. Always allow the estate ────────────────────────────────────────────
-- Our own sites outrank any heuristic. Without this an owned page could be
-- knocked out by a term rule firing on legitimate scripture (see below).
INSERT INTO safety_rules (kind, value, action, source, notes)
SELECT 'domain_allow', host, 'allow', 'curated',
       'Jubilee estate — seeded from ops/config/websites-services.json'
  FROM domains WHERE kind = 'owned'
ON CONFLICT (kind, value) DO NOTHING;

-- ── 2. URL-shape rules ────────────────────────────────────────────────────
-- Cheap, high-precision signals available before a byte of body is fetched.
-- Matched case-insensitively against the full URL as POSIX regex.
INSERT INTO safety_rules (kind, value, action, weight, source, notes) VALUES
  ('url_pattern', '(^|\.)(xxx|porn|sex|adult|cam|escort)\.',        'block', 1.0, 'curated', 'adult TLD/subdomain'),
  ('url_pattern', '/(porn|xxx|nsfw|hentai|escort|camgirl)(/|$|[-_])','block', 1.0, 'curated', 'adult path segment'),
  ('url_pattern', '/(casino|betting|poker|slots)(/|$|[-_])',         'block', 0.8, 'curated', 'gambling path segment'),
  ('url_pattern', '[?&]safe(search)?=(off|0)\b',                     'block', 1.0, 'curated', 'URL explicitly disables safesearch'),
  ('url_pattern', '/(login|signin|checkout|cart|account)(/|$)',      'flag',  0.3, 'curated', 'not useful in an index; skip rather than block')
ON CONFLICT (kind, value) DO NOTHING;

-- ── 3. Term rules ─────────────────────────────────────────────────────────
-- Deliberately SMALL. Terms are the weakest signal of the three and the one
-- most likely to misfire, so they are scored rather than absolute: a term hit
-- lowers pages.safety_score, and only a domain_block or url_pattern hit blocks
-- outright. The classifier combines them (see engine/src/safety.js).
--
-- 'flag' means: keep it out of results, and put it in the review queue for a
-- human. That is the right action for anything ambiguous.
INSERT INTO safety_rules (kind, value, action, weight, source, notes) VALUES
  ('term_flag',  'explicit content',   'flag', 0.5, 'curated', 'self-declared adult content'),
  ('term_flag',  'age verification',   'flag', 0.6, 'curated', 'adult gateway marker'),
  ('term_flag',  '18+ only',           'flag', 0.7, 'curated', 'adult gateway marker'),
  ('term_flag',  'nsfw',               'flag', 0.6, 'curated', 'self-declared'),
  ('term_flag',  'live cam',           'flag', 0.7, 'curated', 'adult webcam marker'),
  ('term_flag',  'online casino',      'flag', 0.5, 'curated', 'gambling'),
  ('term_flag',  'sportsbook',         'flag', 0.5, 'curated', 'gambling')
ON CONFLICT (kind, value) DO NOTHING;

-- ── 4. The scripture problem ──────────────────────────────────────────────
-- A naive keyword filter mangles a Bible site. Scripture discusses adultery,
-- prostitution, rape, incest, drunkenness and slaughter in plain terms, and
-- sermons, commentaries and study notes quote it. A filter that blocks those
-- words makes a faith-based search engine useless at exactly the passages
-- people search for.
--
-- Hence: no term rule above targets a word that appears in scripture, the
-- estate is allow-listed in §1, and term rules only ever move a SCORE. The
-- rows below make that explicit so the next person to add a term rule sees the
-- constraint before they add one that breaks Judges 19.
INSERT INTO safety_rules (kind, value, action, weight, source, notes) VALUES
  ('domain_allow', 'biblegateway.com',   'allow', 1.0, 'curated', 'scripture text — exempt from term scoring'),
  ('domain_allow', 'blueletterbible.org','allow', 1.0, 'curated', 'scripture text — exempt from term scoring'),
  ('domain_allow', 'biblehub.com',       'allow', 1.0, 'curated', 'scripture text — exempt from term scoring'),
  ('domain_allow', 'netbible.org',       'allow', 1.0, 'curated', 'scripture text — exempt from term scoring'),
  ('domain_allow', 'stepbible.org',      'allow', 1.0, 'curated', 'scripture text — exempt from term scoring')
ON CONFLICT (kind, value) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('003_safety_seed')
  ON CONFLICT (version) DO NOTHING;
