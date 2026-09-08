-- 002 — domain registry, pages, chunks.
--
-- §7.1, §7.2, §7.3 of the specification. That DDL is the normative contract and
-- column names are binding, so they are reproduced here verbatim. Additions
-- this engine needs operationally live in 009_operational.sql, kept separate so
-- the contract stays readable against the document.

CREATE TYPE trust_tier   AS ENUM ('T0','T1','T2','T3');
CREATE TYPE domain_status AS ENUM ('pending','active','paused','blocked','purged');
CREATE TYPE ingest_mode  AS ENUM ('source_md','crawl','hybrid');

CREATE TABLE domains (
    id                  BIGSERIAL PRIMARY KEY,
    host                TEXT NOT NULL UNIQUE,           -- 'jubileeverse.com', lowercase, no scheme
    display_name        TEXT,
    tier                trust_tier NOT NULL,
    status              domain_status NOT NULL DEFAULT 'pending',
    ingest_mode         ingest_mode NOT NULL DEFAULT 'crawl',
    source_root         TEXT,                           -- CDN path or repo root for source_md mode
    owner_org           TEXT,
    crawl_interval_hours INT NOT NULL DEFAULT 24,
    max_pages           INT,
    max_depth           INT NOT NULL DEFAULT 5,
    crawl_delay_ms      INT NOT NULL DEFAULT 1000,
    respect_robots      BOOLEAN NOT NULL DEFAULT TRUE,
    render_js           BOOLEAN NOT NULL DEFAULT FALSE,
    sitemap_urls        TEXT[],
    allow_patterns      TEXT[],
    deny_patterns       TEXT[],
    language_hint       TEXT,                           -- BCP-47
    zone_a_eligible     BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE only for verified T1
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    approval_notes      TEXT,
    last_crawl_started  TIMESTAMPTZ,
    last_crawl_finished TIMESTAMPTZ,
    next_crawl_due      TIMESTAMPTZ,
    consecutive_failures INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX domains_due_idx  ON domains (next_crawl_due) WHERE status = 'active';
CREATE INDEX domains_tier_idx ON domains (tier, status);

-- §8.2 is explicit that Zone A placement is guaranteed rather than earned, so
-- ownership verification is "a security control, not a formality". Enforce it
-- in the schema: nothing can be Zone A eligible without being verified T1.
ALTER TABLE domains ADD CONSTRAINT domains_zone_a_requires_t1
    CHECK (NOT zone_a_eligible OR tier = 'T1');

CREATE TYPE page_status AS ENUM
    ('discovered','fetched','extracted','indexed','quarantined','rejected','gone');

CREATE TABLE pages (
    id                BIGSERIAL PRIMARY KEY,
    domain_id         BIGINT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    url               TEXT NOT NULL,
    url_hash          BYTEA NOT NULL,          -- sha256 of normalized url
    canonical_url     TEXT,
    source_path       TEXT,                    -- path to the source .md, when ingest_mode = source_md
    status            page_status NOT NULL DEFAULT 'discovered',
    tier              trust_tier NOT NULL,
    http_status       INT,
    content_type      TEXT,
    etag              TEXT,
    last_modified_http TIMESTAMPTZ,
    content_hash      BYTEA,                   -- sha256 of normalized main text
    title             TEXT,
    description       TEXT,
    author            TEXT,                    -- Inspire persona name for T1
    published_at      TIMESTAMPTZ,
    modified_at       TIMESTAMPTZ,
    language          TEXT,
    word_count        INT,
    body_text         TEXT,
    body_tsv          tsvector,
    og_image_url      TEXT,                    -- metadata only, never fetched or displayed
    outlink_count     INT DEFAULT 0,
    inlink_count      INT DEFAULT 0,
    -- structured metadata lifted from frontmatter (T1) or schema.org (external)
    category          TEXT,                    -- e.g. 'Torah and Hebraic Insights'
    office            TEXT,                    -- five-fold office mapping
    persona           TEXT,
    characters        TEXT[],
    related_slugs     TEXT[],
    tags              TEXT[],
    quality_score     NUMERIC(5,2),            -- 0.00 to 100.00, recomputed nightly
    engagement_score  NUMERIC(5,2),            -- 0.00 to 100.00, from Jubilee Analytics
    ctr_signal        NUMERIC(6,4),            -- bias-corrected, from the click loop
    safety_score      NUMERIC(5,2),
    safety_verdict    TEXT,                    -- 'safe','unsafe','review','unclassified'
    safety_reasons    JSONB,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fetched_at   TIMESTAMPTZ,
    last_indexed_at   TIMESTAMPTZ,
    fetch_failures    INT NOT NULL DEFAULT 0,
    UNIQUE (domain_id, url_hash)
);

CREATE INDEX pages_tsv_idx      ON pages USING GIN (body_tsv);
CREATE INDEX pages_domain_idx   ON pages (domain_id, status);
CREATE INDEX pages_tier_idx     ON pages (tier, status) WHERE status = 'indexed';
CREATE INDEX pages_hash_idx     ON pages (content_hash);
CREATE INDEX pages_tags_idx     ON pages USING GIN (tags);
CREATE INDEX pages_related_idx  ON pages USING GIN (related_slugs);
CREATE INDEX pages_facet_idx    ON pages (category, office) WHERE tier = 'T1';

CREATE TABLE chunks (
    id            BIGSERIAL PRIMARY KEY,
    page_id       BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ordinal       INT NOT NULL,
    heading_path  TEXT,          -- 'H1 > H2 > H3' breadcrumb for context
    text          TEXT NOT NULL,
    token_count   INT,
    embedding     halfvec(1024), -- bge-m3
    embedded_at   TIMESTAMPTZ,
    model_id      TEXT,          -- 'bge-m3@v1' provenance, required for reindex logic
    UNIQUE (page_id, ordinal)
);

CREATE INDEX chunks_embedding_hnsw ON chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX chunks_page_idx    ON chunks (page_id);
CREATE INDEX chunks_pending_idx ON chunks (model_id) WHERE embedded_at IS NULL;
