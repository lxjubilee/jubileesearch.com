-- 005 — best bets, editorial pins (R4, §7.6).
-- The emergency lever: a badly-ranked sensitive query is fixed in seconds
-- without touching the ranking function.

CREATE TABLE best_bets (
    id            BIGSERIAL PRIMARY KEY,
    match_type    TEXT NOT NULL,          -- 'exact','phrase','regex'
    pattern       TEXT NOT NULL,
    lang          TEXT,                   -- NULL = all languages
    target_url    TEXT NOT NULL,
    target_page_id BIGINT REFERENCES pages(id) ON DELETE SET NULL,
    title_override TEXT,
    blurb         TEXT,                   -- editorial, hand-written, max 240 chars
    position      INT NOT NULL DEFAULT 1,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at     TIMESTAMPTZ,
    ends_at       TIMESTAMPTZ,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX best_bets_lookup_idx ON best_bets (match_type, pattern) WHERE active;

ALTER TABLE best_bets ADD CONSTRAINT best_bets_blurb_len CHECK (char_length(blurb) <= 240);
ALTER TABLE best_bets ADD CONSTRAINT best_bets_match_type
    CHECK (match_type IN ('exact','phrase','regex'));

-- "Every best bet records created_by and appears in an audit log" (§13.4).
CREATE TABLE best_bet_audit (
    id           BIGSERIAL PRIMARY KEY,
    best_bet_id  BIGINT,                  -- deliberately not FK: the log outlives the row
    action       TEXT NOT NULL,           -- 'create','update','deactivate','delete'
    actor        TEXT NOT NULL,           -- jubilee_id
    before_state JSONB,
    after_state  JSONB,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX best_bet_audit_idx ON best_bet_audit (best_bet_id, at DESC);
