-- 015 — domain candidates: trust-graph discovery and the T2 approval workflow.
--
-- Two things in §10 and §15 were left half-built, and they turn out to be the
-- same table.
--
-- §10.2 discovers T3 candidates by counting who links to them: "A candidate
-- domain must be independently linked by at least 3 distinct T1 or T2 domains,
-- or be manually nominated." §15 screen 5 reviews T2 candidates: "Nominated
-- domains awaiting T2 approval, with sample pages and an approve or reject
-- decision recorded with reviewer and timestamp."
--
-- One is found by machine and one is nominated by a person, but both are a host
-- that is not in the registry, waiting on a decision, with evidence attached.
-- `target_tier` is the only thing that separates them, and keeping them in one
-- table means one review queue rather than two that drift apart.
--
-- Nothing here is servable. A candidate has no `domains` row until it is
-- promoted, so §10.2's "nothing from a candidate domain is served in results
-- while it sits in T0" holds because there is nothing to serve from.

CREATE TYPE candidate_status AS ENUM (
    'nominated',   -- proposed, nothing checked yet
    'screening',   -- gate 1 has run; awaiting a crawl sample or a human
    'approved',    -- a human said yes; not yet in the registry
    'rejected',    -- a human said no, or gate 1 refused it
    'promoted'     -- now a row in `domains`
);

CREATE TABLE domain_candidates (
    id                BIGSERIAL PRIMARY KEY,
    host              TEXT NOT NULL UNIQUE,
    target_tier       trust_tier NOT NULL DEFAULT 'T3',
    source            TEXT NOT NULL,        -- 'trust_graph','manual','zero_result'
    status            candidate_status NOT NULL DEFAULT 'nominated',

    -- The evidence §10.2 requires. `linking_hosts` is kept alongside the count
    -- because a reviewer's first question is always "linked by whom", and a
    -- number cannot answer it.
    linking_domains   INT NOT NULL DEFAULT 0,
    linking_hosts     TEXT[],
    sample_urls       TEXT[],               -- what a reviewer would look at first

    nominated_by      TEXT,                 -- jubilee_id, for a manual nomination
    nomination_note   TEXT,

    -- Gate 1 (§11.1) run against the host before a single page is fetched.
    screening_verdict TEXT,                 -- 'clear','blocked','allowlisted'
    screening_reasons JSONB,
    screened_at       TIMESTAMPTZ,

    reviewed_by       TEXT,
    reviewed_at       TIMESTAMPTZ,
    review_notes      TEXT,

    promoted_domain_id BIGINT REFERENCES domains(id) ON DELETE SET NULL,

    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX domain_candidates_queue_idx ON domain_candidates (status, target_tier, linking_domains DESC);
CREATE INDEX domain_candidates_pending_idx ON domain_candidates (first_seen_at)
    WHERE status IN ('nominated', 'screening');

COMMENT ON TABLE domain_candidates IS
    'Hosts proposed for the index but not in it. Trust-graph nominations (spec 10.2) and editorial T2 nominations (spec 15 screen 5) share this queue.';

COMMENT ON COLUMN domain_candidates.target_tier IS
    'T2 for an editorial whitelist nomination, T3 for a trust-graph discovery. Decides which review queue it appears in and what it is promoted to.';

-- §10.2: "No candidate domain is crawled beyond 20 pages until it has passed
-- domain-level classification." A promoted candidate therefore enters at T0
-- with a page cap, and only a passing sample moves it to its target tier.
-- These are the numbers that rule turns into, and they are runtime-editable
-- like every other threshold.
INSERT INTO ranking_config (key, value, description) VALUES
    ('discovery_min_linking_domains', 3,
     'Distinct T1/T2 domains that must link to a host before it is nominated (spec 10.2)'),
    ('discovery_probe_pages', 20,
     'Pages crawled from a candidate before it may be promoted past T0 (spec 10.2)'),
    ('discovery_min_pass_rate', 0.9,
     'Fraction of probe pages that must clear the safety gates before promotion to T3')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The link graph, queryable by host.
--
-- §10.2's rule is "linked by at least 3 distinct T1 or T2 domains", which is a
-- GROUP BY over the host being linked *to*. `links` stores the full URL and its
-- hash, so answering that meant a regex over every row in the table — and this
-- is the largest table in the schema, one row per outbound link per page. The
-- host is denormalised on write instead.
-- ---------------------------------------------------------------------------
ALTER TABLE links ADD COLUMN to_host TEXT;

-- Backfill whatever is already there. The regex handles the scheme and any
-- credentials, port or path; it is only ever run once, here.
UPDATE links
   SET to_host = lower(regexp_replace(
                   regexp_replace(to_url, '^[a-z]+://(?:[^@/]*@)?', '', 'i'),
                   '[:/?#].*$', ''))
 WHERE to_host IS NULL;

UPDATE links SET to_host = regexp_replace(to_host, '^www\.', '')
 WHERE to_host LIKE 'www.%';

CREATE INDEX links_to_host_idx ON links (to_host) WHERE NOT is_internal;

COMMENT ON COLUMN links.to_host IS
    'Registrable host of to_url, lowercase, no leading www. Written by the crawler; what trust-graph discovery groups on (spec 10.2).';

-- ---------------------------------------------------------------------------
-- Blocklist load history (§15 screen 7: "Loaded sources, refresh status,
-- manual entries").
--
-- bin/load-blocklists.mjs replaces a source's rows wholesale on each run, which
-- means the entries themselves carry no history: a source that started
-- returning an empty file would silently shrink to nothing and the table would
-- look the same as one that had never been loaded. This is the record that
-- makes that visible.
-- ---------------------------------------------------------------------------
CREATE TABLE blocklist_loads (
    id           BIGSERIAL PRIMARY KEY,
    source       TEXT NOT NULL,
    url          TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    entries_parsed  INT,
    entries_written INT,
    outcome      TEXT NOT NULL DEFAULT 'running',  -- 'ok','empty','failed','dry_run'
    error        TEXT
);
CREATE INDEX blocklist_loads_source_idx ON blocklist_loads (source, started_at DESC);
