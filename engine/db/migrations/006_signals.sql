-- 006 — the signal loop: impressions, clicks, engagement (R7, R8, §7.7).
--
-- Phase note from §18: this ships in Phase 3 even though nothing reads it until
-- Phase 5. "Data not collected is data that cannot be recovered."

CREATE TABLE search_queries (
    id            BIGSERIAL PRIMARY KEY,
    query_text    TEXT NOT NULL,
    normalized    TEXT,
    expanded_concepts BIGINT[],           -- lexicon_concepts hit, for tuning
    intent        TEXT,                   -- 'scripture','navigational','entity','topical','conversational'
    lang          TEXT,
    jubilee_id    TEXT,                   -- nullable, from SSO
    session_id    TEXT,
    zone_a_count  INT,
    zone_b_count  INT,
    cache_hit     BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms    INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_queries_time_idx   ON search_queries (created_at);
CREATE INDEX search_queries_norm_idx   ON search_queries (normalized);
CREATE INDEX search_queries_intent_idx ON search_queries (intent, created_at);

CREATE TABLE result_impressions (
    id            BIGSERIAL PRIMARY KEY,
    query_id      BIGINT NOT NULL REFERENCES search_queries(id) ON DELETE CASCADE,
    page_id       BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    zone          CHAR(1) NOT NULL,       -- 'A' or 'B'
    position      INT NOT NULL,           -- position within its zone
    clicked       BOOLEAN NOT NULL DEFAULT FALSE,
    clicked_at    TIMESTAMPTZ,
    dwell_ms      INT                     -- from Analytics, when resolvable
);
CREATE INDEX result_impressions_page_idx  ON result_impressions (page_id);
CREATE INDEX result_impressions_query_idx ON result_impressions (query_id);
-- POST /api/v1/event resolves (query_id, page_id, zone, position) to one row.
CREATE UNIQUE INDEX result_impressions_slot_idx
    ON result_impressions (query_id, zone, position);

-- nightly rollup, the table the ranker actually reads
CREATE TABLE query_page_ctr (
    normalized_query TEXT NOT NULL,
    page_id       BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    impressions   INT NOT NULL,
    clicks        INT NOT NULL,
    raw_ctr       NUMERIC(6,4),
    corrected_ctr NUMERIC(6,4),           -- position-bias corrected
    confidence    NUMERIC(4,3),           -- shrinks toward 0 on low volume
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (normalized_query, page_id)
);

CREATE TABLE position_bias (
    zone          CHAR(1) NOT NULL,
    position      INT NOT NULL,
    examination_prob NUMERIC(6,4) NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (zone, position)
);

CREATE TABLE page_engagement (
    page_id       BIGINT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    window_days   INT NOT NULL DEFAULT 30,
    pageviews     INT,
    median_dwell_ms INT,
    scroll_depth_pct NUMERIC(5,2),
    bounce_rate   NUMERIC(5,2),
    completion_rate NUMERIC(5,2),
    engagement_score NUMERIC(5,2),        -- 0.00 to 100.00, composite
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
