-- 003 — crawl frontier, link graph, blocklists, safety review queue (§7.4).

CREATE TABLE crawl_queue (
    id            BIGSERIAL PRIMARY KEY,
    url           TEXT NOT NULL,
    url_hash      BYTEA NOT NULL UNIQUE,
    domain_id     BIGINT REFERENCES domains(id),
    tier          trust_tier NOT NULL,
    priority      INT NOT NULL DEFAULT 100,   -- lower runs first; publish-push uses 1
    depth         INT NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'crawl', -- 'crawl','webhook','manual','reconcile'
    discovered_from BIGINT REFERENCES pages(id),
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_by    TEXT,
    claimed_at    TIMESTAMPTZ,
    attempts      INT NOT NULL DEFAULT 0,
    last_error    TEXT
);
CREATE INDEX crawl_queue_ready_idx ON crawl_queue (priority, scheduled_for)
    WHERE claimed_by IS NULL;

CREATE TABLE links (
    from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    to_url_hash  BYTEA NOT NULL,
    to_url       TEXT NOT NULL,
    anchor_text  TEXT,
    rel          TEXT,
    is_internal  BOOLEAN NOT NULL,
    PRIMARY KEY (from_page_id, to_url_hash)
);
-- Trust-graph expansion (§10.2) counts distinct trusted domains linking to a
-- candidate host, which reads this the other way round.
CREATE INDEX links_to_idx ON links (to_url_hash) WHERE NOT is_internal;

CREATE TABLE blocklist_entries (
    id         BIGSERIAL PRIMARY KEY,
    pattern    TEXT NOT NULL,
    match_type TEXT NOT NULL,            -- 'host','suffix','regex','keyword'
    category   TEXT NOT NULL,
    source     TEXT NOT NULL,            -- 'ut1','stevenblack','manual'
    severity   INT NOT NULL DEFAULT 100, -- 100 = automatic hard block
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX blocklist_lookup_idx ON blocklist_entries (match_type, pattern);

CREATE TABLE safety_reviews (
    id          BIGSERIAL PRIMARY KEY,
    page_id     BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    verdict     TEXT,                    -- 'approve','reject','block_domain'
    reviewer    TEXT,
    machine_score NUMERIC(5,2),
    machine_reasons JSONB,
    notes       TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX safety_reviews_pending_idx ON safety_reviews (reviewed_at)
    WHERE reviewed_at IS NULL;
