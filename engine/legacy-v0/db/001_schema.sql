-- ---------------------------------------------------------------------------
-- JubileeSearch — core index schema
--
-- One Postgres database (`jubileesearch`) holds the whole engine: the crawl
-- frontier, the fetched documents, the link graph, the media inventory and the
-- family-safety verdicts that gate everything before it can be returned.
--
-- Two rules run through the design:
--   1. NOTHING is servable until it has been rated. pages.safety_verdict and
--      media.safety_verdict both default to 'unrated', and the serving views at
--      the bottom of this file expose only 'safe'. A crawl that outruns the
--      classifier therefore returns nothing, rather than something unchecked.
--   2. Every row records WHY. safety_reasons carries the rule ids that fired,
--      so a parent (or an admin) can be told exactly why a page was excluded.
--
-- Applied by engine/db/migrate.sh. Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- domains — the crawl frontier's roots, and the policy that applies to each
-- ---------------------------------------------------------------------------
-- `kind` separates the sites we own (crawled deeply, trusted by default) from
-- the open web (crawled shallowly, guilty until proven family-safe).
CREATE TABLE IF NOT EXISTS domains (
  id                  bigserial PRIMARY KEY,
  host                text NOT NULL UNIQUE,          -- 'jsvbible.com' — no scheme, no www
  kind                text NOT NULL DEFAULT 'external'
                        CHECK (kind IN ('owned', 'partner', 'external')),
  -- Editorial trust. 'owned'/'allowlist' skip the heuristic gate; 'review' must
  -- pass it; 'blocked' is never fetched and never served.
  trust               text NOT NULL DEFAULT 'review'
                        CHECK (trust IN ('owned', 'allowlist', 'review', 'blocked')),
  safety_rating       text NOT NULL DEFAULT 'unrated'
                        CHECK (safety_rating IN ('family_safe', 'unrated', 'adult', 'blocked')),

  crawl_enabled       boolean NOT NULL DEFAULT true,
  respect_robots      boolean NOT NULL DEFAULT true,
  crawl_delay_ms      integer NOT NULL DEFAULT 1000 CHECK (crawl_delay_ms >= 0),
  max_pages           integer NOT NULL DEFAULT 5000 CHECK (max_pages >= 0),
  max_depth           integer NOT NULL DEFAULT 4    CHECK (max_depth >= 0),
  -- How often the whole host is revisited. Per-page freshness is decided by
  -- pages.next_crawl_at, which is seeded from this.
  recrawl_hours       integer NOT NULL DEFAULT 168  CHECK (recrawl_hours > 0),

  robots_txt          text,
  robots_fetched_at   timestamptz,
  last_crawled_at     timestamptz,
  next_crawl_at       timestamptz NOT NULL DEFAULT now(),

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS domains_due_idx
  ON domains (next_crawl_at) WHERE crawl_enabled AND trust <> 'blocked';
CREATE INDEX IF NOT EXISTS domains_kind_idx ON domains (kind, trust);

-- ---------------------------------------------------------------------------
-- pages — one row per URL we have fetched (or tried to)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  id                 bigserial PRIMARY KEY,
  domain_id          bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  url                text NOT NULL,
  -- btree cannot index an arbitrarily long URL, so uniqueness rides on the hash.
  url_hash           bytea GENERATED ALWAYS AS (sha256(url::bytea)) STORED,
  canonical_url      text,

  http_status        integer,
  content_type       text,
  lang               text,
  etag               text,
  http_last_modified text,

  title              text,
  description        text,
  body_text          text,
  -- Change detection: if the hash is unchanged we refresh the timestamps and
  -- skip re-indexing, which is what keeps a weekly recrawl cheap.
  content_hash       bytea,
  word_count         integer NOT NULL DEFAULT 0,

  -- Ranking inputs. inlink_count is recomputed from `links`; boost is manual.
  inlink_count       integer NOT NULL DEFAULT 0,
  boost              real NOT NULL DEFAULT 1.0,

  safety_verdict     text NOT NULL DEFAULT 'unrated'
                       CHECK (safety_verdict IN ('safe', 'unrated', 'flagged', 'blocked')),
  safety_score       real,                    -- 0..1, higher = safer
  safety_reasons     text[] NOT NULL DEFAULT '{}',
  safety_checked_at  timestamptz,

  fetch_attempts     integer NOT NULL DEFAULT 0,
  fetch_error        text,

  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_crawled_at    timestamptz,
  last_modified_at   timestamptz,
  next_crawl_at      timestamptz,

  -- Weighted full-text vector: a title hit outranks a body hit.
  fts tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, coalesce(title, '')),       'A')
     || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B')
     || setweight(to_tsvector('english'::regconfig, coalesce(body_text, '')),   'C')
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS pages_url_hash_key ON pages (url_hash);
CREATE INDEX IF NOT EXISTS pages_fts_idx        ON pages USING gin (fts);
CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS pages_domain_idx     ON pages (domain_id);
CREATE INDEX IF NOT EXISTS pages_due_idx        ON pages (next_crawl_at) WHERE next_crawl_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_unrated_idx    ON pages (safety_checked_at) WHERE safety_verdict = 'unrated';

-- ---------------------------------------------------------------------------
-- crawl_queue — the frontier
-- ---------------------------------------------------------------------------
-- Workers claim with SELECT ... FOR UPDATE SKIP LOCKED, so several crawler
-- processes can share one queue without coordinating.
CREATE TABLE IF NOT EXISTS crawl_queue (
  id              bigserial PRIMARY KEY,
  url             text NOT NULL,
  url_hash        bytea GENERATED ALWAYS AS (sha256(url::bytea)) STORED,
  domain_id       bigint REFERENCES domains(id) ON DELETE CASCADE,
  depth           integer NOT NULL DEFAULT 0,
  priority        integer NOT NULL DEFAULT 100,   -- lower runs first
  discovered_from bigint REFERENCES pages(id) ON DELETE SET NULL,
  state           text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'claimed', 'done', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  claimed_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: a URL can only be in flight once, but it may be queued
-- again later for a recrawl once the earlier attempt is done/failed.
CREATE UNIQUE INDEX IF NOT EXISTS crawl_queue_pending_url_key
  ON crawl_queue (url_hash) WHERE state IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS crawl_queue_next_idx
  ON crawl_queue (priority, scheduled_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS crawl_queue_domain_idx ON crawl_queue (domain_id, state);

-- ---------------------------------------------------------------------------
-- links — the page graph, for ranking and for discovering new URLs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS links (
  from_page_id  bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_url        text NOT NULL,
  to_url_hash   bytea GENERATED ALWAYS AS (sha256(to_url::bytea)) STORED,
  to_page_id    bigint REFERENCES pages(id) ON DELETE SET NULL,
  anchor_text   text,
  nofollow      boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS links_edge_key ON links (from_page_id, to_url_hash);
CREATE INDEX IF NOT EXISTS links_to_idx ON links (to_url_hash);

-- ---------------------------------------------------------------------------
-- media — images and video found on a page
-- ---------------------------------------------------------------------------
-- Deliberately its own table with its own verdict: an image on an otherwise
-- fine page still has to be cleared on its own before it can be shown.
CREATE TABLE IF NOT EXISTS media (
  id                bigserial PRIMARY KEY,
  page_id           bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('image', 'video')),
  url               text NOT NULL,
  url_hash          bytea GENERATED ALWAYS AS (sha256(url::bytea)) STORED,
  alt_text          text,
  title             text,
  mime              text,
  width             integer,
  height            integer,
  bytes             bigint,
  duration_s        integer,                   -- video only

  safety_verdict    text NOT NULL DEFAULT 'unrated'
                      CHECK (safety_verdict IN ('safe', 'unrated', 'flagged', 'blocked')),
  safety_score      real,
  safety_reasons    text[] NOT NULL DEFAULT '{}',
  classifier        text,                      -- which model/ruleset decided
  safety_checked_at timestamptz,

  first_seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_page_url_key ON media (page_id, url_hash);
CREATE INDEX IF NOT EXISTS media_unrated_idx ON media (kind) WHERE safety_verdict = 'unrated';

-- ---------------------------------------------------------------------------
-- safety_rules — the family-safety ruleset, as data rather than code
-- ---------------------------------------------------------------------------
-- Rules live in the database so the filter can be tightened without a deploy,
-- and so every exclusion can name the rule that caused it.
CREATE TABLE IF NOT EXISTS safety_rules (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN
                ('domain_block', 'domain_allow', 'url_pattern', 'term_block', 'term_flag')),
  value       text NOT NULL,
  -- 'block' removes it outright; 'flag' keeps it out of results but queues it
  -- for a human look; 'allow' overrides a block from a broader rule.
  action      text NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'flag', 'allow')),
  weight      real NOT NULL DEFAULT 1.0,
  source      text,                          -- 'curated', 'ut1', 'shallalist', …
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS safety_rules_key ON safety_rules (kind, value);
CREATE INDEX IF NOT EXISTS safety_rules_active_idx ON safety_rules (kind) WHERE active;

-- ---------------------------------------------------------------------------
-- crawl_runs — observability
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_runs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('owned', 'external', 'recrawl', 'manual')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  pages_fetched integer NOT NULL DEFAULT 0,
  pages_indexed integer NOT NULL DEFAULT 0,
  pages_blocked integer NOT NULL DEFAULT 0,
  media_seen    integer NOT NULL DEFAULT 0,
  errors        integer NOT NULL DEFAULT 0,
  notes         text
);

-- ---------------------------------------------------------------------------
-- queries — what people searched for (drives suggestions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queries (
  id             bigserial PRIMARY KEY,
  q_normalized   text NOT NULL UNIQUE,
  hits           integer NOT NULL DEFAULT 1,
  results_count  integer,
  -- Suggestions have to be family-safe too: a query only becomes a suggestion
  -- once it has been cleared, so the box can never autocomplete into something
  -- a child should not see.
  safety_verdict text NOT NULL DEFAULT 'unrated'
                   CHECK (safety_verdict IN ('safe', 'unrated', 'flagged', 'blocked')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queries_trgm_idx ON queries USING gin (q_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS queries_popular_idx ON queries (hits DESC) WHERE safety_verdict = 'safe';

-- ---------------------------------------------------------------------------
-- Serving views — the ONLY thing the API is allowed to read from
-- ---------------------------------------------------------------------------
-- Reading through these is what makes "unrated is not servable" structural,
-- rather than a filter somebody can forget to write into a query.
CREATE OR REPLACE VIEW servable_pages AS
  SELECT p.*, d.host, d.kind AS domain_kind, d.trust AS domain_trust
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
   WHERE p.safety_verdict = 'safe'
     AND d.trust <> 'blocked'
     AND d.safety_rating IN ('family_safe', 'unrated')
     AND p.http_status BETWEEN 200 AND 299;

CREATE OR REPLACE VIEW servable_media AS
  SELECT m.*, p.url AS page_url, d.host
    FROM media m
    JOIN pages p   ON p.id = m.page_id
    JOIN domains d ON d.id = p.domain_id
   WHERE m.safety_verdict = 'safe'
     AND p.safety_verdict = 'safe'
     AND d.trust <> 'blocked';

INSERT INTO schema_migrations (version) VALUES ('001_schema')
  ON CONFLICT (version) DO NOTHING;
