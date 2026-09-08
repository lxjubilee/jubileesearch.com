-- 024 — bootstrap blocklist (§11.1 gates 1 and 2).
--
-- The bulk of gate 1 is loaded, not seeded: `bin/load-blocklists.mjs` pulls the
-- external category lists into `blocklist_entries`. This file holds only the
-- Jubilee-maintained rules, which no external list can supply.
--
-- ---------------------------------------------------------------------------
-- THE SCRIPTURE PROBLEM. Read this before adding a keyword rule.
--
-- A naive keyword filter mangles a Bible site. Scripture discusses adultery,
-- prostitution, rape, incest, drunkenness and slaughter in plain terms, and
-- sermons and commentaries quote it at length. A filter that blocks those words
-- makes a faith-based search engine useless at exactly the passages people come
-- to it for. Judges 19 is the test case: if a rule you are about to add would
-- exclude a commentary on Judges 19, the rule is wrong.
--
-- So the discipline is:
--
--   * No keyword rule targets a word that appears in scripture.
--   * Keyword rules carry severity < 100, which routes to the human review
--     queue rather than rejecting (§11.1 gate 2: heuristics "are fast and cheap
--     but noisy, so they route to review rather than automatic rejection unless
--     the term is on the hard list").
--   * Severity 100 is reserved for terms that have no innocent reading in any
--     of the network's languages -- overwhelmingly commercial adult and
--     exploitation terms, not subject matter.
--
-- This paragraph survived from the v0 schema, where it was written for the same
-- reason. It is repeated here because this is the file the next person edits.
-- ---------------------------------------------------------------------------
--
-- A note on sources. §11.1 requires the loader to be source-agnostic and warns
-- against architecting around a dead feed: "Some historically popular lists,
-- including Shallalist, are no longer maintained." The v0 engine did architect
-- around Shallalist. It is not referenced here, and `bin/load-blocklists.mjs`
-- reads its sources from configuration so a list that dies can be swapped
-- without a code change. Availability, licence terms and update cadence of each
-- list must be confirmed at build time.

INSERT INTO blocklist_entries (pattern, match_type, category, source, severity) VALUES
    -- Hard list. No innocent reading; blocks pre-fetch without review.
    ('porn',            'keyword', 'adult',        'manual', 100),
    ('pornhub',         'host',    'adult',        'manual', 100),
    ('xxx',             'suffix',  'adult',        'manual', 100),
    ('camgirl',         'keyword', 'adult',        'manual', 100),
    ('escort-service',  'keyword', 'adult',        'manual', 100),
    ('onlyfans',        'keyword', 'adult',        'manual', 100),
    ('hentai',          'keyword', 'adult',        'manual', 100),
    ('nsfw',            'keyword', 'adult',        'manual', 100),
    ('sexcam',          'keyword', 'adult',        'manual', 100),
    ('casino',          'keyword', 'gambling',     'manual', 100),
    ('betting-odds',    'keyword', 'gambling',     'manual', 100),
    ('sportsbook',      'keyword', 'gambling',     'manual', 100),
    ('darkweb',         'keyword', 'illegal',      'manual', 100),

    -- Soft list. Routes to review (gate 4), never auto-rejects. Every one of
    -- these has a legitimate reading on a ministry site: recovery testimony,
    -- apologetics, counselling resources, a sermon on a hard passage.
    ('gambling',        'keyword', 'gambling',     'manual',  40),
    ('addiction',       'keyword', 'substances',   'manual',  20),
    ('suicide',         'keyword', 'self-harm',    'manual',  30),
    ('self-harm',       'keyword', 'self-harm',    'manual',  30),
    ('occult',          'keyword', 'occult',       'manual',  30),
    ('witchcraft',      'keyword', 'occult',       'manual',  20),
    ('firearms-sale',   'keyword', 'weapons',      'manual',  40),
    ('buy-ammo',        'keyword', 'weapons',      'manual',  50),
    ('vape',            'keyword', 'substances',   'manual',  40),
    ('cannabis-shop',   'keyword', 'substances',   'manual',  50)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Allow overrides.
--
-- These hosts are exempted from keyword heuristics because their whole purpose
-- is to publish and discuss the text that the heuristics trip on. They still
-- pass gate 3 content classification like anything else; the exemption is from
-- the noisy gate, not from the gate that matters.
--
-- Severity 0 is the convention for an allow entry: `blocklist_entries` holds
-- both directions, and the classifier reads severity 0 as "never let a keyword
-- rule fire against this host". Jubilee's own estate is already exempt by tier
-- (T1 skips gates entirely, §4), so it is not listed here.
-- ---------------------------------------------------------------------------
INSERT INTO blocklist_entries (pattern, match_type, category, source, severity) VALUES
    ('biblegateway.com',   'host', 'allow:scripture', 'manual', 0),
    ('blueletterbible.org','host', 'allow:scripture', 'manual', 0),
    ('biblehub.com',       'host', 'allow:scripture', 'manual', 0),
    ('netbible.org',       'host', 'allow:scripture', 'manual', 0),
    ('sefaria.org',        'host', 'allow:scripture', 'manual', 0),
    ('stepbible.org',      'host', 'allow:scripture', 'manual', 0)
ON CONFLICT DO NOTHING;
