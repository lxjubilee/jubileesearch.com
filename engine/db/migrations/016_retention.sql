-- 016 — log retention (§17 Privacy).
--
-- "Query logs retain `jubilee_id` only where the user is signed in, and are
--  purged or anonymized after 13 months. No cross-site behavioral profiles.
--  Aggregate click learning only."
--
-- The first clause was already true: `orchestrator.js` writes `jubilee_id` only
-- when the caller presented a token. The second was not implemented at all —
-- nothing aged anything out, so a query logged on the first day would have sat
-- there indefinitely.
--
-- That gap matters more than an ordinary missing feature, because §17 Legal also
-- requires publishing a search privacy notice. A notice that promises deletion
-- the code does not perform is not a documentation problem; it is a false
-- statement to every reader who trusts it. The job exists so the page can be
-- written honestly.
--
-- **Anonymise, not delete.** §17 permits either, and anonymising is the better
-- reading of the same paragraph: it also says "Aggregate click learning only",
-- and the click loop (R7) learns from impressions joined to `search_queries`.
-- Deleting the rows would discard years of aggregate signal to remove an
-- identifier that can simply be removed on its own. What is dropped is
-- everything that ties a query to a person; what remains is that somebody, once,
-- searched for something and clicked a result.

INSERT INTO ranking_config (key, value, description) VALUES
    ('retention_identify_days', 395,
     'Days before jubilee_id and session_id are stripped from a query log. 13 months (spec 17).'),
    ('retention_reporter_ip_days', 395,
     'Days before an abuse report''s reporter IP is dropped. It exists to investigate the report, not to keep.'),
    ('retention_crawl_failure_days', 90,
     'Days of crawl_failures kept. Operational diagnostics, not a record of anyone.'),
    ('retention_webhook_nonce_hours', 1,
     'Replay-protection nonces are only meaningful inside the 5-minute signature window (spec 9.2).')
ON CONFLICT (key) DO NOTHING;

-- What the retention job actually scans. Without this it is a sequential scan
-- over every query ever logged, nightly, forever.
CREATE INDEX search_queries_retention_idx ON search_queries (created_at)
    WHERE jubilee_id IS NOT NULL OR session_id IS NOT NULL;

CREATE INDEX abuse_reports_retention_idx ON abuse_reports (created_at)
    WHERE reporter_ip IS NOT NULL;

-- A record of each pass, so "we anonymise after thirteen months" is a claim
-- somebody can audit rather than one they have to take on trust.
CREATE TABLE retention_runs (
    id                 BIGSERIAL PRIMARY KEY,
    ran_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    queries_anonymised INT NOT NULL DEFAULT 0,
    ips_dropped        INT NOT NULL DEFAULT 0,
    failures_deleted   INT NOT NULL DEFAULT 0,
    nonces_deleted     INT NOT NULL DEFAULT 0,
    cache_swept        INT NOT NULL DEFAULT 0,
    oldest_identified  TIMESTAMPTZ
);

COMMENT ON TABLE retention_runs IS
    'One row per retention pass. oldest_identified is the age of the oldest query log still carrying an identifier -- if it exceeds the configured window, the job is not running.';

COMMENT ON COLUMN search_queries.jubilee_id IS
    'From SSO, and only ever set when the user was signed in (spec 17). Stripped by the retention job after retention_identify_days.';

COMMENT ON COLUMN abuse_reports.reporter_ip IS
    'Kept only to investigate the report it belongs to. Dropped by the retention job after retention_reporter_ip_days.';
