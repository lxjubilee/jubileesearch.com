-- 014 — crawl bookkeeping the frontier needs.
--
-- §9.3 adaptive backoff: "A domain unchanged across three consecutive runs has
-- its interval increased by 50%, capped at 30 days." Counting to three needs
-- somewhere to keep the count. `consecutive_failures` already exists for the
-- pause-after-three-failures rule in §9.4; this is its counterpart for the
-- quieter case, where nothing is wrong and there is simply nothing new.

ALTER TABLE domains
    ADD COLUMN consecutive_unchanged_runs INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN domains.consecutive_unchanged_runs IS
    'Runs in a row that found no changed page. Drives the adaptive recrawl interval (spec 9.3).';

-- The crawl worker resolves a queue item to an existing page by url_hash, which
-- is sha256 over the normalised URL. The frontier writes that hash in SQL and
-- the ingest path writes it in JavaScript, so the two must agree byte for byte:
-- sha256(convert_to(url, 'UTF8')) is exactly what
-- createHash('sha256').update(url) produces for the same string.
--
-- This index is what makes that lookup cheap on the crawl path. `pages` already
-- has UNIQUE (domain_id, url_hash), which cannot serve a lookup by hash alone.
CREATE INDEX pages_url_hash_idx ON pages (url_hash);

-- §9.4: "Three consecutive hard failures pause the domain and raise an admin
-- alert." The pause is applied by the frontier; this is the record the alert and
-- the admin console read, so a paused domain can say why it is paused.
CREATE TABLE crawl_failures (
    id         BIGSERIAL PRIMARY KEY,
    domain_id  BIGINT REFERENCES domains(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    status     INT,
    reason     TEXT NOT NULL,
    outcome    TEXT NOT NULL,   -- 'error','robots_denied','skipped','gone'
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crawl_failures_domain_idx ON crawl_failures (domain_id, at DESC);

-- Evidence for acceptance criterion 5: "Robots.txt is provably honored on
-- external domains, evidenced by a test against a controlled disallow rule."
-- Every refusal is written here with the rule that caused it, so the evidence is
-- a query rather than a log grep.
COMMENT ON TABLE crawl_failures IS
    'Every non-success outcome from the fetcher, including robots refusals. Acceptance criterion 5 is a SELECT against this.';
