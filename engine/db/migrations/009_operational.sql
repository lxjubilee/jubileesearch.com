-- 009 — operational tables the specification requires by reference but does not
-- give DDL for. Kept out of 002–008 so those stay verbatim against §7 and can be
-- diffed against the document without noise.

-- §13.6: "All weights live in a configuration table and are adjustable at
-- runtime without deployment." Admin screen 9 edits this; every change is
-- logged so the "one-click revert" has something to revert to.
CREATE TABLE ranking_config (
    key         TEXT PRIMARY KEY,
    value       NUMERIC NOT NULL,
    description TEXT,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ranking_config_audit (
    id         BIGSERIAL PRIMARY KEY,
    key        TEXT NOT NULL,
    old_value  NUMERIC,
    new_value  NUMERIC NOT NULL,
    actor      TEXT NOT NULL,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ranking_config_audit_idx ON ranking_config_audit (key, at DESC);

-- §7.9: "The cache_key includes an index-version counter that is bumped on any
-- reindex or ranking-parameter change, which invalidates everything atomically
-- without a delete sweep."
CREATE TABLE index_version (
    id         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- single row
    version    BIGINT NOT NULL DEFAULT 1,
    bumped_by  TEXT,
    bumped_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO index_version (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Bumping the index version is the cache invalidation primitive. Changing a
-- ranking weight must bump it, or the cache serves results scored under the old
-- weights until they expire.
CREATE FUNCTION bump_index_version(actor TEXT) RETURNS BIGINT AS $$
    UPDATE index_version
       SET version = version + 1, bumped_by = actor, bumped_at = now()
     WHERE id RETURNING version;
$$ LANGUAGE sql;

CREATE FUNCTION ranking_config_bump() RETURNS TRIGGER AS $$
BEGIN
    PERFORM bump_index_version(COALESCE(NEW.updated_by, 'system'));
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ranking_config_bumps_index
    AFTER INSERT OR UPDATE OF value ON ranking_config
    FOR EACH ROW EXECUTE FUNCTION ranking_config_bump();

-- §9.1 step 6: map slug to the live public URL, "so results link to the
-- published page even though the index was built from source".
-- §9.2: per-domain HMAC shared secret for the publish webhook.
-- §8.2: ownership verification token.
ALTER TABLE domains
    ADD COLUMN url_template        TEXT,   -- e.g. 'https://{host}/{category_slug}/{slug}'
    ADD COLUMN webhook_secret      TEXT,   -- HMAC-SHA256 shared secret (§9.2)
    ADD COLUMN verification_token  TEXT,
    ADD COLUMN verification_method TEXT,   -- 'dns_txt','well_known','authoritative_list'
    ADD COLUMN verified_at         TIMESTAMPTZ,
    ADD COLUMN unsafe_strikes      INT NOT NULL DEFAULT 0;  -- §11.1 gate 3, 5 = auto-block

COMMENT ON COLUMN domains.webhook_secret IS
    'Shared secret for /api/v1/ingest/notify HMAC. Never returned by any admin read endpoint.';

-- §11.3 abuse reporting. Three reports suppress a page until a human clears it.
CREATE TABLE abuse_reports (
    id          BIGSERIAL PRIMARY KEY,
    page_id     BIGINT REFERENCES pages(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    reason      TEXT NOT NULL,
    note        TEXT,
    reporter_ip INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX abuse_reports_page_idx ON abuse_reports (page_id);

ALTER TABLE pages ADD COLUMN suppressed BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN pages.suppressed IS
    'Set by abuse reporting (spec 11.3) or admin demotion. Excluded from servable_pages.';

-- Observability for the ingest and crawl runs (§15 dashboard, acceptance 1).
CREATE TABLE ingest_runs (
    id           BIGSERIAL PRIMARY KEY,
    domain_id    BIGINT REFERENCES domains(id) ON DELETE CASCADE,
    mode         TEXT NOT NULL,          -- 'source_md','crawl','reconcile','webhook'
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    pages_seen   INT NOT NULL DEFAULT 0,
    pages_changed INT NOT NULL DEFAULT 0,
    pages_failed INT NOT NULL DEFAULT 0,
    error        TEXT
);
CREATE INDEX ingest_runs_domain_idx ON ingest_runs (domain_id, started_at DESC);

-- Replay protection for the ingest webhook (§9.2, 5-minute window).
CREATE UNLOGGED TABLE webhook_nonces (
    signature  TEXT PRIMARY KEY,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_nonces_age_idx ON webhook_nonces (seen_at);
