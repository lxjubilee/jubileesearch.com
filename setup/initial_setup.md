# JubileeSearch.com
## Specification, Guidelines, and Developer Requirements

**Document:** jubilee-search-specification.md
**Version:** 1.1
**Date:** 3 September 2026
**Owner:** Gabriel Ungureanu, CTO, Jubilee Software, Inc.
**Audience:** AI developer, backend engineers, offshore delivery team
**Status:** Draft for approval

**Changes in v1.1:** All ten relevance and efficiency recommendations integrated (R1 through R10, traceability in Appendix C). Image results removed from scope entirely, including the deferred v2 image tier and its NSFW screening subsystem. Results presentation changed from a single blended list to a two-zone layout. T1 ingest changed from HTML crawling to source markdown ingest with publish-time push.

---

## 1. Purpose

JubileeSearch.com is Jubilee's own search engine. It exists to do three things, in priority order:

1. **Make the Jubilee network findable.** Over 130 owned domains and 10,000+ article pages currently have no unified way to be searched. A visitor on any Jubilee property should be able to find any content on any other Jubilee property.
2. **Curate a trusted faith-based web.** A whitelist of approved external faith-based sites is indexed alongside Jubilee content, so a search returns edifying results instead of whatever a general engine surfaces.
3. **Offer a family-safe window on the open web.** A discovery crawler extends the index beyond the whitelist, but only content that clears every safety gate is stored. Default posture is **deny**.

The engine must return results that are *semantically* relevant, not just keyword matches. A user who searches "why do I feel far from God" should get the right teaching article even if that exact phrase appears nowhere in it. A user who searches "Holy Spirit" must find pages that say "Ruach HaKodesh," and a user who searches "repentance" must find pages built on "teshuvah."

---

## 2. Scope

### 2.1 In scope (v1)

- Domain registry with per-domain crawl policy
- **Source-first ingest of owned content from markdown, with publish-time push**
- Nightly recrawl of all registered Jubilee domains with change detection
- Whitelist tier for approved external faith-based domains
- Discovery crawler for the open web with mandatory safety classification
- Content extraction, normalization, chunking
- PostgreSQL storage with `pgvector` embeddings and native full-text search
- **Query intent routing, register and language query expansion, editorial best-bets**
- Hybrid retrieval (lexical + vector) with fusion and reranking
- **Two-zone results presentation: Jubilee first, wider web beneath**
- **Impression and click logging with position-bias correction**
- **Engagement-driven quality scoring fed by Jubilee Analytics**
- **Two-layer caching of query embeddings and result sets**
- Public search API and public search UI
- Admin console for domains, whitelist, lexicon, best-bets, safety review, and index health
- Embeddable search widget for other Jubilee sites

### 2.2 Out of scope

**Image search is out of scope for this product.** Not deferred, not phased, not planned. There is no image tier, no image index, no thumbnail pipeline, and no NSFW image classification subsystem. Result cards render text only. The only image-adjacent data stored is the OpenGraph image URL on T1 pages, retained as a metadata field for possible future use by other Jubilee systems, and it is never fetched, never cached, and never rendered in search results at any tier.

Also out of scope for v1:

- Video and audio search
- Personalized ranking based on individual user history (aggregate click learning is in scope; per-user profiling is not)
- Paid placement or advertising in results
- Public search API for third parties
- Generated or synthesized answers (see principle P7)

---

## 3. Product principles

These are non-negotiable and every design decision defers to them.

| # | Principle | Consequence |
|---|---|---|
| P1 | **Default deny** | No page enters the open-web tier until it has passed every safety gate. Uncertain means excluded. |
| P2 | **Tiered trust** | Trust determines which zone a result appears in, and zone placement is structural, not a scoring contest. |
| P3 | **Postgres first** | One database technology. No Elasticsearch, no MySQL, no separate vector store for this system. |
| P4 | **Explainable results** | Every result row must be able to answer "why was this returned, in which zone, and why at this position." |
| P5 | **Reversible** | Any domain, page, or tier can be purged from the index with one admin action and one job run. |
| P6 | **Polite crawling** | Robots.txt, crawl-delay, and rate limits are honored on external domains without exception. |
| P7 | **No editorial fabrication** | The engine indexes, ranks, and quotes extracted text. It does not summarize doctrine, generate answers, or synthesize claims. |
| P8 | **Jubilee occupies its own zone** | Owned content is never in rank competition with external content. Separate retrieval, separate ranking, separate block. |
| P9 | **Own your signals** | Where Jubilee owns both the content and the measurement, real engagement outranks structural guesswork. |
| P10 | **Text only** | No images are indexed, stored as binaries, screened, or displayed. |

---

## 4. Trust tiers

Every indexed page carries exactly one tier. Tier drives zone placement, retention, and crawl frequency.

| Tier | Name | Contents | Refresh cadence | Safety gate | Result zone |
|---|---|---|---|---|---|
| **T1** | Jubilee Owned | All domains in the Jubilee network | Publish-time push, nightly reconciliation | Trusted, skip classification | Zone A |
| **T2** | Whitelist | Manually approved faith-based external sites | Weekly | Approved at domain level, spot-checked at page level | Zone B, boosted |
| **T3** | Open Web | Discovered pages that passed all safety gates | Monthly, or on demand | Full classification pipeline, default deny | Zone B |
| **T0** | Quarantine | Fetched but failed or pending classification | Not served | Held for review or purge, never returned in results | none |

**Zone A** is the Jubilee block. **Zone B** is the wider web block. See Section 13.5. Within Zone B, T2 receives a modest boost over T3 so approved faith-based sites lead the external results. Across zones there is no multiplier at all, because there is no competition to arbitrate.

---

## 5. System architecture

```
                    +---------------------------+
                    |   JubileeSearch.com Web   |
                    |   Zone A + Zone B render  |
                    +-------------+-------------+
                                  |
                    +-------------v-------------+
                    |      Search API           |
                    |  /search /suggest /event  |
                    +-------------+-------------+
                                  |
                    +-------------v-------------+
                    |    Query Orchestrator     |
                    |  1 normalize              |
                    |  2 intent router          |
                    |  3 lexicon expansion      |
                    |  4 best-bets lookup       |
                    |  5 cache check            |
                    |  6 dual-zone retrieval    |
                    |  7 fuse, rerank, assemble |
                    +--+--------+--------+------+
                       |        |        |
             +---------v-+  +---v----+  +v-------------+
             | Zone A     |  | Zone B |  | Result cache |
             | retrieval  |  | retr.  |  | + embed cache|
             | (T1 only)  |  |(T2,T3) |  |              |
             +---------+--+  +---+----+  +--------------+
                       |         |
                       +----+----+
                            |
        +-------------------v-------------------------+
        |        PostgreSQL 16+ with pgvector          |
        |  domains | pages | chunks | links | queue    |
        |  lexicon | best_bets | impressions | clicks  |
        |  safety  | entities | quality_signals        |
        +----^--------------------------------^--------+
             |                                |
   +---------+-----------+         +----------+-----------+
   |  SOURCE-FIRST INGEST |         |   CRAWL PIPELINE     |
   |  (T1)                |         |   (T1 reconcile,     |
   |  markdown ingest svc |         |    T2, T3)           |
   |  publish webhook     |         |  frontier | fetcher  |
   |  frontmatter mapper  |         |  extractor|classifier|
   +---------+-----------+         +----------+-----------+
             |                                |
             +----------------+---------------+
                              |
              +---------------v----------------+
              |   Embedding Service            |
              |   calls Jubilee Inference API  |
              |   (RTX PRO 6000 inference card)|
              +--------------------------------+

   +-------------------------------------------------------+
   |  Signal Loop (nightly background services)            |
   |  click aggregation -> position-bias correction ->     |
   |  ctr signal ; Jubilee Analytics engagement ->         |
   |  quality_score recompute                              |
   +-------------------------------------------------------+
```

All long-running components run as **background services** under systemd (Linux) or as Windows Services, managed by a single supervisor. Every service is horizontally scalable and stateless except for its database connection.

---

## 6. Technology stack

### 6.1 Recommended stack (the pick)

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16 or 17** with `pgvector` >= 0.7, `pg_trgm`, `unaccent`, `pgcrypto` | Single-technology mandate. `pgvector` 0.7+ adds `halfvec`, which halves embedding storage with negligible recall loss. |
| Crawl framework | **Scrapy** (Python) with `scrapy-playwright` for JavaScript-rendered pages | Mature politeness controls, robots.txt handling, retry and throttle middleware. Used for T2 and T3, plus T1 reconciliation only. |
| Markdown ingest | Custom service using `python-frontmatter` + `markdown-it-py` | T1 primary path. Reads the source .md and YAML frontmatter directly. See Section 9.1. |
| Content extraction | **Trafilatura** primary, `readability-lxml` fallback | Purpose-built boilerplate removal, used for external tiers where no source markdown exists. |
| Language detection | `fasttext` `lid.176` model or `py3langid` | The network spans English, Romanian, Hindi, and 70-nation content. |
| Embeddings | **BAAI/bge-m3** served through the Jubilee Inference API | 1024 dimensions, multilingual, 8192-token context. One model covers English, Romanian, Hindi, and transliterated Hebrew, so the whole index shares one vector space. |
| Reranking | **BAAI/bge-reranker-v2-m3** cross-encoder, top 50 per zone | Large precision gain at the top of each block for a small latency cost. |
| Safety classification | Layered: blocklists, heuristics, then a local LLM call through the Inference API | See Section 11. Text classification only. |
| Cache | Postgres unlogged tables for the result cache, in-process LRU for hot query embeddings | Keeps P3 intact. No Redis. See Section 13.7. |
| Service API | **FastAPI** (Python) for ingest, crawl, index, and search services | Same language as the ML stack, so no cross-language model serving. |
| Public web front end | Jubilee's existing standard web stack, consuming the Search API over HTTP | Presentation only. Zero business logic. |
| Job queue | Postgres-backed queue using `SELECT ... FOR UPDATE SKIP LOCKED` | Proven to millions of jobs per day at far larger scale than this. |
| Scheduler | systemd timers or a single supervisor loop | No external scheduler needed at this scale. |

### 6.2 Viable alternatives, and when to switch

| Instead of | Consider | Trigger to switch |
|---|---|---|
| Scrapy | **Crawlee (Node or Python)** | If the team is stronger in TypeScript than Python. Better built-in browser-pool management. |
| Scrapy | **Apache Nutch** or **StormCrawler** | Only if the open-web tier exceeds roughly 50 million pages. Both are JVM and add real operational weight. |
| pgvector HNSW | **ParadeDB `pg_search`** (BM25 in Postgres) | If Postgres native full-text ranking proves too weak on the lexical side. Still a Postgres extension, so P3 holds. |
| pgvector | **Qdrant** | Only if vector count exceeds roughly 50 million chunks and query latency degrades past target. Already in the ecosystem for the persona layer, so a known fallback, not a new technology. |
| bge-m3 | multilingual-e5-large, or a Qwen3 embedding model | If evaluation on the Jubilee gold-set shows materially better recall. Changing the model means a full reindex, so settle this before Phase 4. |

**Verification note:** model names, dimensions, and extension version numbers above should be confirmed against current upstream documentation at build time. They are accurate to the best of current knowledge but this stack moves fast.

---

## 7. Data model

PostgreSQL DDL below is the normative contract. Column names are binding; types may be tuned.

### 7.1 Domain registry

```sql
CREATE TYPE trust_tier AS ENUM ('T0','T1','T2','T3');
CREATE TYPE domain_status AS ENUM ('pending','active','paused','blocked','purged');
CREATE TYPE ingest_mode AS ENUM ('source_md','crawl','hybrid');

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

CREATE INDEX ON domains (next_crawl_due) WHERE status = 'active';
CREATE INDEX ON domains (tier, status);
```

### 7.2 Pages

```sql
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

CREATE INDEX ON pages USING GIN (body_tsv);
CREATE INDEX ON pages (domain_id, status);
CREATE INDEX ON pages (tier, status) WHERE status = 'indexed';
CREATE INDEX ON pages (content_hash);
CREATE INDEX ON pages USING GIN (tags);
CREATE INDEX ON pages USING GIN (related_slugs);
CREATE INDEX ON pages (category, office) WHERE tier = 'T1';
```

`body_tsv` is maintained by a trigger. Because Postgres ships no stemming dictionary for Hebrew or Hindi, those languages fall back to the `simple` configuration. This is a known limitation and one reason the vector side of retrieval matters so much for non-English content, alongside the lexicon in Section 7.5.

### 7.3 Chunks and embeddings

```sql
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

CREATE INDEX ON chunks (page_id);
CREATE INDEX ON chunks (model_id) WHERE embedded_at IS NULL;
```

Storing `model_id` per chunk is mandatory. It is what makes a model upgrade a rolling background job instead of a full outage.

### 7.4 Crawl, link, and safety tables

```sql
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
CREATE INDEX ON crawl_queue (priority, scheduled_for) WHERE claimed_by IS NULL;

CREATE TABLE links (
    from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    to_url_hash  BYTEA NOT NULL,
    to_url       TEXT NOT NULL,
    anchor_text  TEXT,
    rel          TEXT,
    is_internal  BOOLEAN NOT NULL,
    PRIMARY KEY (from_page_id, to_url_hash)
);

CREATE TABLE blocklist_entries (
    id         BIGSERIAL PRIMARY KEY,
    pattern    TEXT NOT NULL,
    match_type TEXT NOT NULL,            -- 'host','suffix','regex','keyword'
    category   TEXT NOT NULL,
    source     TEXT NOT NULL,            -- 'ut1','stevenblack','manual'
    severity   INT NOT NULL DEFAULT 100, -- 100 = automatic hard block
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON blocklist_entries (match_type, pattern);

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
CREATE INDEX ON safety_reviews (reviewed_at) WHERE reviewed_at IS NULL;
```

### 7.5 Lexicon: register and language bridge (R2)

```sql
CREATE TABLE lexicon_concepts (
    id          BIGSERIAL PRIMARY KEY,
    concept_key TEXT NOT NULL UNIQUE,     -- 'ruach_hakodesh', 'teshuvah', 'yeshua'
    gloss       TEXT,                     -- short human description for the admin UI
    notes       TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lexicon_terms (
    id          BIGSERIAL PRIMARY KEY,
    concept_id  BIGINT NOT NULL REFERENCES lexicon_concepts(id) ON DELETE CASCADE,
    term        TEXT NOT NULL,            -- surface form, lowercase, unaccented
    lang        TEXT NOT NULL,            -- BCP-47
    register    TEXT,                     -- 'OHI','CCI','common', internal label only
    weight      NUMERIC(4,2) NOT NULL DEFAULT 1.00,  -- expansion weight, 1.00 = full
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (term, lang, concept_id)
);
CREATE INDEX ON lexicon_terms (term);
CREATE INDEX ON lexicon_terms (concept_id);
```

**Critical constraint:** the `register` column holds internal labels only. These values are never exposed in the search UI, in API responses, or in any reader-facing surface. They exist so the admin console can group terms sensibly during editing.

### 7.6 Best bets, editorial pins (R4)

```sql
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
CREATE INDEX ON best_bets (match_type, pattern) WHERE active;
```

Best bets render above Zone A, visually distinct, capped at 2 per query. The `blurb` is written by a human editor and is the one place in the product where editorial prose appears in results. This does not violate P7 because nothing is machine-generated.

### 7.7 Signal loop: impressions, clicks, engagement (R7, R8)

```sql
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
CREATE INDEX ON search_queries (created_at);
CREATE INDEX ON search_queries (normalized);
CREATE INDEX ON search_queries (intent, created_at);

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
CREATE INDEX ON result_impressions (page_id);
CREATE INDEX ON result_impressions (query_id);

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
```

### 7.8 Entity panels (R10)

```sql
CREATE TABLE entities (
    id            BIGSERIAL PRIMARY KEY,
    entity_key    TEXT NOT NULL UNIQUE,   -- 'shavuot', 'zev-inspire', 'chesed'
    entity_type   TEXT NOT NULL,          -- 'hebrew_word','feast','persona','book','concept','place'
    display_name  TEXT NOT NULL,
    summary       TEXT,                   -- sourced from JubileePedia, never generated here
    source_url    TEXT NOT NULL,          -- JubileePedia canonical URL
    facts         JSONB,                  -- ordered label/value pairs for the panel
    related_urls  JSONB,
    concept_id    BIGINT REFERENCES lexicon_concepts(id),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    synced_at     TIMESTAMPTZ
);

CREATE TABLE entity_aliases (
    entity_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias         TEXT NOT NULL,
    lang          TEXT,
    PRIMARY KEY (entity_id, alias, lang)
);
CREATE INDEX ON entity_aliases (alias);
```

Panel content is pulled from JubileePedia and stored verbatim. JubileeSearch does not author or summarize it. Panels are **text only**, consistent with P10.

### 7.9 Cache (R9)

```sql
CREATE UNLOGGED TABLE result_cache (
    cache_key     TEXT PRIMARY KEY,       -- hash of normalized query + filters + version
    payload       JSONB NOT NULL,
    hit_count     INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON result_cache (expires_at);

CREATE UNLOGGED TABLE embedding_cache (
    query_hash    TEXT PRIMARY KEY,
    normalized    TEXT NOT NULL,
    embedding     halfvec(1024) NOT NULL,
    model_id      TEXT NOT NULL,
    hit_count     INT NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`UNLOGGED` is deliberate. Cache contents are disposable, and skipping the write-ahead log removes the write cost. A crash empties the cache and the system refills it. The `cache_key` includes an index-version counter that is bumped on any reindex or ranking-parameter change, which invalidates everything atomically without a delete sweep.

---

## 8. Domain registration

### 8.1 Registration methods

Three ways a domain enters `domains`, all landing in `status = 'pending'`:

1. **Admin form.** Host, tier, ingest mode, and policy entered by hand in the admin console.
2. **Bulk import.** CSV or JSON upload for the initial load of the 130+ owned domains.
3. **API.** `POST /api/v1/admin/domains` so the domain provisioning process for new Jubilee sites registers the site with search automatically at launch.

**Requirement:** when a new Jubilee site goes live, registration with JubileeSearch must be a step in the launch checklist, not an afterthought. The provisioning script calls the API.

### 8.2 Ownership verification (T1 only)

A domain may only be assigned tier T1 and `zone_a_eligible = TRUE` after ownership is proven by one of:

- DNS TXT record `jubilee-search-verification=<token>`
- File at `/.well-known/jubilee-search-<token>.txt`
- Presence in the authoritative Jubilee domain list maintained by the network administrator

Because Zone A is a guaranteed placement rather than a scoring boost, this verification is the only thing standing between the network and an external site claiming premium real estate. Treat it as a security control, not a formality.

### 8.3 Per-domain policy defaults by tier

| Field | T1 | T2 | T3 |
|---|---|---|---|
| `ingest_mode` | source_md, hybrid fallback | crawl | crawl |
| `crawl_interval_hours` | 24 (reconciliation only) | 168 | 720 |
| `max_pages` | unlimited | 5,000 | 500 |
| `max_depth` | 10 | 4 | 2 |
| `crawl_delay_ms` | 250 | 1,500 | 2,500 |
| `respect_robots` | configurable | always TRUE | always TRUE |

---

## 9. Ingest and crawl services

### 9.1 Source-first ingest for T1 (R5)

Owned content already exists as markdown with YAML frontmatter on the CDN. Crawling the rendered HTML discards that structure and then pays a boilerplate-stripping tax to recover a degraded version of text that was clean at the source. **T1 ingests from the source markdown.**

**Ingest Service responsibilities:**

1. Enumerate `.md` files under each domain's `source_root`
2. Parse frontmatter and body with `python-frontmatter`
3. Map frontmatter fields to `pages` columns:

| Frontmatter field | Page column |
|---|---|
| `title` | `title` |
| `slug` | used to compose `url` |
| `author` or persona field | `author`, `persona` |
| `category` | `category` |
| office mapping | `office` |
| `created` | `published_at` |
| `updated` | `modified_at` |
| `language` | `language` |
| `tags` | `tags` |
| `characters` | `characters` |
| `related_slugs` | `related_slugs` |
| `image` filename | `og_image_url` (metadata only, never displayed) |

4. Strip markdown syntax to plain text for `body_text` while preserving heading structure for the chunker's `heading_path`
5. Compute `content_hash` and skip everything downstream if unchanged
6. Map `slug` to the live public URL using the domain's URL template, so results link to the published page even though the index was built from source

**Benefits, stated concretely:** no fetch, no JavaScript rendering, no boilerplate extraction, no metadata guessing. Faceted filtering by persona, category, office, and tag comes free. Estimated reduction in nightly compute on the owned network is on the order of 70%.

**Fallback:** any T1 domain without accessible source markdown runs `ingest_mode = 'crawl'` and follows Section 9.3. `hybrid` mode ingests source markdown where available and crawls the remainder.

### 9.2 Publish-time push (R6)

A webhook endpoint accepts a publish or update event from any Jubilee publishing system:

```
POST /api/v1/ingest/notify
{
  "host": "jubileeverse.com",
  "source_path": "articles/torah-and-hebraic-insights/become-a-believing-believer.md",
  "url": "https://jubileeverse.com/torah/become-a-believing-believer",
  "event": "publish" | "update" | "unpublish",
  "signature": "<hmac-sha256>"
}
```

- Requests are authenticated by HMAC using a per-domain shared secret. Reject unsigned or stale requests (timestamp window of 5 minutes).
- The event enqueues at `priority = 1`, ahead of all scheduled work.
- Target: searchable within 60 seconds of publication.
- `unpublish` marks the page `gone`, removes it from results immediately, and cascades a chunk delete.
- **The nightly run does not go away.** It becomes a reconciliation pass that catches missed webhooks, detects deletions, and repairs drift. Webhooks are an optimization, never the sole source of truth.

### 9.3 Frontier Service (T1 reconciliation, T2, T3)

- Selects domains where `next_crawl_due <= now()` and `status = 'active'`
- Seeds from `sitemap.xml`, `sitemap_index.xml`, and RSS or Atom feeds first; falls back to link discovery only when no sitemap exists
- Enforces per-domain page and depth caps
- Applies a **per-host politeness lock** so only one fetcher touches a host at a time on T2 and T3
- Adaptive backoff: a domain unchanged across three consecutive runs has its interval increased by 50%, capped at 30 days. A domain that changed materially has it decreased toward its floor.

### 9.4 Fetcher Service

- Sends `If-None-Match` and `If-Modified-Since` on every recrawl. A `304 Not Modified` costs one cheap request and skips the entire downstream pipeline.
- User-Agent string, fixed and honest:
  `JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)`
- A public bot information page at that URL must exist before the first external crawl, explaining what the crawler does and how to block it.
- Honors `robots.txt` including `Crawl-delay`, and honors `X-Robots-Tag` and `<meta name="robots">` directives.
- Global and per-host rate limits, both runtime configurable.
- Exponential backoff on 429 and 5xx. Three consecutive hard failures pause the domain and raise an admin alert.
- Headless rendering via Playwright only when `render_js = TRUE`. Rendering costs roughly 10 to 40 times a plain fetch, so it stays off by default and is enabled per domain only after evidence that content requires it.
- Response body cap of 5 MB. Content types other than HTML, XHTML, plain text, and PDF are skipped.
- **Images are never fetched.** Image URLs are recorded as metadata on T1 only and discarded on T2 and T3.

### 9.5 Extractor Service

For each fetched document:

1. Detect charset and language
2. Extract main content with Trafilatura, stripping navigation, footers, cookie banners, and comments
3. Pull metadata: `<title>`, meta description, canonical link, OpenGraph fields, JSON-LD `Article` schema, author, published and modified dates
4. Extract outbound links with anchor text into `links`
5. Compute `content_hash` over the normalized main text

**Change detection:** if `content_hash` matches the stored value, update `last_fetched_at` and stop. No re-extraction, no re-embedding, no reindex. Only changed pages consume GPU time.

**PDF handling:** text-layer extraction only. No OCR. Scanned PDFs with no text layer are marked `rejected` with reason `no_text_layer`.

### 9.6 Deduplication

- **Exact:** same `content_hash` across pages means one canonical page is indexed and the rest are marked duplicates pointing to it.
- **Near-duplicate:** SimHash or MinHash over shingles with a configurable Hamming distance threshold. Necessary because syndicated Jubilee articles appear on multiple network domains.
- **Canonical preference order:** the page whose URL matches `canonical_url`, then the T1 page, then the oldest `first_seen_at`.

---

## 10. Open-web discovery

### 10.1 An honest constraint, stated plainly

Crawling "the Internet" is not a feature that can be switched on. General web crawls run to billions of pages and cost far more in bandwidth, storage, and compute than the value they would return here. **Do not attempt a broad web crawl.** The recommended approach delivers most of the benefit at a small fraction of the cost:

**Trust-graph expansion.** Start from the T2 whitelist. Follow outbound links to a limited depth. A site linked to by three or more independent trusted sites becomes a candidate. Candidates run the full safety pipeline before any page is indexed. The web's own link structure does the discovery work, and the seed set guarantees topical relevance.

**Optional supplement:** the Common Crawl public dataset can be mined offline for candidate domains matching faith-related signals, without Jubilee operating a large crawler at all. This is a batch analysis job, not a crawler, and it is a late-phase item at the earliest.

### 10.2 Discovery rules

- Expansion depth from a trusted seed is capped at 2 hops
- A candidate domain must be independently linked by at least 3 distinct T1 or T2 domains, or be manually nominated
- No candidate domain is crawled beyond 20 pages until it has passed domain-level classification
- Nothing from a candidate domain is served in results while it sits in T0

### 10.3 Zero-result queries as a discovery input

Queries that return nothing in either zone are logged and reviewed. They serve two purposes: they are content assignments for the writing team (Section 16), and they are seeds for targeted whitelist nomination when the gap is genuinely outside Jubilee's scope.

---

## 11. Safety and family-friendly classification

This is the highest-risk subsystem in the build. If it fails, JubileeSearch returns something a child should not see on a ministry site. Design it defensively.

### 11.1 Gate sequence

Every T3 page passes through all gates in order. **Failing any gate ends the process with exclusion.** T2 pages run gates 1, 2, and 4 as a spot check. T1 pages skip gates entirely.

**Gate 1: Domain reputation (pre-fetch).**
Check the host against `blocklist_entries` before spending a single request. Sources to load and refresh:

- The University of Toulouse (UT1) categorized blocklists, widely used in school and library filtering
- The StevenBlack consolidated hosts project, including its adult and gambling variants
- A manual Jubilee blocklist maintained in the admin console

*Verification required:* confirm current availability, license terms, and update cadence for each list before the build. Some historically popular lists, including Shallalist, are no longer maintained. Do not architect around a dead feed. Whatever sources are chosen, the loader must be source-agnostic and refresh on a schedule.

Optionally, resolve the candidate host against a family-filtering DNS resolver such as Cloudflare's family service (1.1.1.3) and treat a blocked answer as a hard fail. Cheap, high-signal, low effort.

**Gate 2: URL and metadata heuristics (pre-fetch and post-fetch).**
Keyword matching against the host, path, query string, `<title>`, and meta description using a maintained term list covering adult content, gambling, drugs, weapons sales, hate speech, and self-harm. Multi-language, because the network is not English-only. Heuristics are fast and cheap but noisy, so they route to review rather than automatic rejection unless the term is on the hard list.

**Gate 3: Content classification (post-extraction).**
The extracted body text is classified by a local model served through the Jubilee Inference API on the RTX PRO 6000 inference card. Output is structured JSON, never free prose:

```json
{
  "safe_for_family": true,
  "confidence": 0.94,
  "categories": ["christian-teaching", "devotional"],
  "flags": [],
  "reason": "Devotional article on forgiveness. No adult, violent, or exploitative content."
}
```

Decision thresholds, all runtime configurable:

| Verdict | Confidence | Action |
|---|---|---|
| safe | >= 0.90 | Index into T3 |
| safe | 0.70 to 0.89 | Queue for human review |
| safe | < 0.70 | Reject |
| unsafe | any | Reject, and increment a domain-level strike counter |

A domain accumulating 5 unsafe pages is automatically moved to `status = 'blocked'` and all of its indexed pages are purged. This is deliberately aggressive.

**Gate 4: Human review queue.**
Everything in the 0.70 to 0.89 band lands in `safety_reviews` with a null `reviewed_at`. The admin console shows the page text, the machine verdict, and approve, reject, and block-domain buttons. Target queue latency is under 48 hours.

**Gate 5: Ongoing revalidation.**
Sites change. Any T3 page whose `content_hash` changes is reclassified from scratch. A random 1% sample of the T3 index is reclassified weekly as an audit, and the pass rate is a tracked metric.

### 11.2 No images, and what that removes

Because image results are out of scope (Section 2.2, principle P10), the following subsystems are **not built and must not be built**: image fetching, thumbnail generation, image storage, image CDN integration, and NSFW image classification. This removes the most expensive and highest-risk component of the original safety design. Result cards at every tier render text only: title, URL, snippet, and tier label.

### 11.3 Abuse reporting

Every result carries a "Report this result" link. A report immediately drops the page below the fold pending review and creates a `safety_reviews` row at top priority. Three reports on one page suppress it from results automatically until a human clears it.

### 11.4 Doctrinal filtering: an open question

Family-safe and doctrinally sound are different tests. A site can be entirely clean and still teach something Jubilee would not put its name beside.

**Recommendation:** do not build doctrinal filtering into the automated pipeline. Machines are poor judges of theology, and false rejections would be both embarrassing and unfair. Instead:

- T2 whitelist membership is a human editorial decision and is where doctrinal judgment belongs
- Zone B carries a plain-language label indicating results come from the wider web and are not Jubilee-endorsed
- The admin console supports manual demotion or removal of any specific page or domain

The two-zone layout (R1) makes this far cleaner than it would have been in a blended list, because the boundary between "ours" and "not ours" is now visible to the user rather than buried in a ranking function. Gabriel's decision is still needed (Section 20, D3).

---

## 12. Chunking and embeddings

### 12.1 Chunking rules

- Target 400 to 600 tokens per chunk, 15% overlap
- Split on heading boundaries first, then paragraph boundaries, never mid-sentence
- Each chunk stores its `heading_path` breadcrumb, and the chunk text is prefixed with the page title plus that breadcrumb before embedding, which materially improves retrieval on long articles
- For T1 source-markdown ingest, heading structure comes directly from the markdown tree rather than being inferred from HTML, which produces cleaner boundaries
- Pages under 100 words produce a single chunk
- Pages under 25 words of main content are rejected as thin content

### 12.2 Embedding job

- Runs as a background service consuming `chunks WHERE embedded_at IS NULL`
- Batches of 32 to 64 chunks per Inference API call
- Writes `embedding`, `embedded_at`, and `model_id` in one transaction
- Retries with backoff; after 3 failures marks the chunk for manual inspection rather than silently dropping it
- Publish-push chunks jump the queue at `priority = 1` to meet the 60-second freshness target
- Throughput target: the full 10,000-page T1 corpus embeddable in under 4 hours on the inference card

### 12.3 Model change protocol

Changing the embedding model invalidates the entire vector index. The protocol:

1. Add a second embedding column or a parallel `chunks_v2` table
2. Backfill under the new `model_id` while the old index continues serving
3. Run the gold-set evaluation against both
4. Cut over the query path only when the new model wins
5. Drop the old column and bump the cache index-version counter

Never delete-and-reembed in place. That is a multi-hour outage.

---

## 13. Query pipeline

### 13.1 Overview

```
query text
   |
 [1] normalize: trim, lowercase, unaccent, collapse whitespace, strip punctuation
   |
 [2] detect language
   |
 [3] INTENT ROUTER  ->  scripture | navigational | entity | topical | conversational
   |                         |            |           |
   |                    scripture     direct site   entity panel
   |                      card         result       (text only)
   |
 [4] LEXICON EXPANSION: map surface terms to concepts, expand to sibling terms
   |
 [5] BEST BETS lookup (exact, phrase, regex)  -> pinned block, max 2
   |
 [6] CACHE check (result cache, then embedding cache)
   |
   +---------------- ZONE A (T1 only) --------------+---------- ZONE B (T2, T3) ----------+
   |  lexical: websearch_to_tsquery + expansion     |  lexical: same, top 100             |
   |  semantic: HNSW over T1 chunks, top 100        |  semantic: HNSW over T2/T3, top 100 |
   |  RRF fuse (k=60)                               |  RRF fuse (k=60)                    |
   |  signal boost: quality, engagement, ctr, lang  |  boost: T2 tier, safety, freshness  |
   |  rerank top 50 -> take 3 to 5 (coverage-aware) |  rerank top 50 -> take 10           |
   +------------------------------------------------+-------------------------------------+
   |
 [7] ASSEMBLE: best bets, entity panel, Zone A, Zone B, thread suggestions
   |
 [8] LOG impressions with zone and position
```

### 13.2 Intent router (R3)

Classification happens before retrieval. Cheap deterministic rules first, small classifier only as fallback.

| Intent | Detection | Response |
|---|---|---|
| **scripture** | Regex for book, chapter, and optional verse in English, Romanian, and Hebrew transliteration, matched against a canonical book-name table with abbreviations | **Scripture card** rendered above everything: JSV text of the passage, reference, and a link to the full chapter. Normal results follow beneath. |
| **navigational** | Query matches a registered domain name, site display name, or a known brand token with high confidence | Direct site result rendered first, with up to 3 deep links from that host |
| **entity** | Query matches an `entity_aliases` row | Entity panel (text only) rendered beside or above Zone A |
| **topical** | Default for multi-word conceptual queries | Standard two-zone retrieval |
| **conversational** | Natural-language question form detected by leading interrogative plus length | Standard two-zone retrieval with semantic weighting increased and lexical weighting reduced |

**Scripture card constraints:** the card renders JSV text pulled from the authoritative source. It is quoted, never paraphrased, never commented on, and never generated. Cited simply as JSV with no edition label, consistent with house standard. If the passage cannot be retrieved with certainty, the card is not rendered at all and the query falls through to normal results. Silence is correct; a wrong verse is not.

### 13.3 Lexicon expansion (R2)

1. Tokenize the normalized query into unigrams and bigrams
2. Look up each against `lexicon_terms`
3. For each matched `concept_id`, retrieve sibling terms in the query language and in English
4. Build an expanded lexical query with the original terms at full weight and expanded terms at their configured `weight` (default 0.60)
5. Record matched concept IDs in `search_queries.expanded_concepts` for tuning

Expansion applies to the **lexical** path. The vector path already bridges much of this semantically, and double-expanding it degrades precision.

**Seed lexicon, to be authored before Phase 3 by Gabriel or a delegate.** Minimum viable set of roughly 60 to 100 concepts, including:

- Divine names and titles: Yahuah / LORD / Yahweh, Yeshua / Jesus, Elohim / God, Ruach HaKodesh / Ruach Kodesh / Holy Spirit, HaMashiach / Messiah / Christ
- Core concepts: teshuvah / repentance / return, chesed / lovingkindness / mercy, shalom / peace, mishpachah / family / community, Torah / instruction / law, mitzvot / commandments, kadosh / holy / set apart
- Feasts: each appointed time under its Hebrew name, common English name, and Romanian name
- Romanian pairs for high-traffic English terms, given the bilingual properties in the network
- Hindi pairs for translated deliverables

**Hebrew article rule enforced in the data:** stored surface forms use "Ruach HaKodesh" or "the Ruach Kodesh." The admin console rejects any term entry that would produce a doubled article. This is a validation rule in the lexicon editor, not a style suggestion.

### 13.4 Best bets (R4)

- Matched before retrieval, rendered above Zone A in a visually distinct block
- Maximum 2 per query
- Support scheduling via `starts_at` and `ends_at` for seasonal pins, such as a feast-day query during the appointed time
- Every best bet records `created_by` and appears in an audit log
- Best bets do not suppress organic results; Zone A still renders beneath

This is the emergency lever. When a sensitive query ranks badly, it is fixed in seconds without touching the ranking function.

### 13.5 Two-zone results (R1)

**Zone A, "From Jubilee":** T1 only. Always rendered first when it has qualifying results.

Coverage-aware sizing prevents padding the block with weak matches:

| Zone A top result score | Results shown in Zone A |
|---|---|
| Strong (above high threshold) | 5 |
| Moderate | 3 |
| Weak (below floor) | 2 |
| Below minimum relevance floor | 0, with an honest empty state |

Thresholds are runtime configurable. **The floor is the discipline that makes this work.** A Zone A that shows five irrelevant Jubilee pages on every query teaches users to skip the block entirely, which destroys exactly the priority it was built to protect. When the network has no good answer, say so plainly and give the space to Zone B.

Empty-state copy for Zone A, warm and honest: an indication that Jubilee has not covered this yet, plus a link inviting a suggestion. Every one of those is logged as a content gap.

**Zone B, "From the wider web":** T2 and T3. Always rendered, always beneath Zone A, always labeled. Within Zone B, T2 receives a modest boost so approved faith-based sites lead.

**Host diversity:** maximum 3 results per host in Zone A and 2 per host in Zone B on the first page.

**User controls:** a Zone B collapse toggle whose state persists per session, and filter chips for "Jubilee only" and "All results." Default is both zones expanded.

### 13.6 Ranking signals

Zone A and Zone B use different signal sets because they have different information available.

**Zone A final score:**
```
score = rrf
      * (1 + w_quality   * quality_score/100)
      * (1 + w_engage    * engagement_score/100)
      * (1 + w_ctr       * corrected_ctr * ctr_confidence)
      * (1 + w_lang      * lang_match)
      * (1 + w_fresh     * freshness_decay)
```

**Zone B final score:**
```
score = rrf
      * (1 + w_tier2     * is_t2)
      * (1 + w_safety    * safety_score/100)
      * (1 + w_ctr       * corrected_ctr * ctr_confidence)
      * (1 + w_lang      * lang_match)
      * (1 + w_fresh     * freshness_decay)
```

All weights live in a configuration table and are adjustable at runtime without deployment. Starting values:

| Weight | Value |
|---|---|
| `w_quality` | 0.15 |
| `w_engage` | 0.20 |
| `w_ctr` | 0.25 |
| `w_lang` | 0.20 |
| `w_fresh` | 0.08 |
| `w_tier2` | 0.10 |
| `w_safety` | 0.05 |

Note there is **no tier multiplier across zones.** Zone separation replaced it. That was the point of R1.

### 13.7 Caching (R9)

**Layer 1, result cache.** Key is a hash of the normalized query, expansion set, filters, zone configuration, and index-version counter. Time to live of 15 minutes for topical queries, 60 minutes for navigational and entity queries, and 0 (bypass) whenever a best bet matched or a debug flag is set. On a hit, the entire retrieval path is skipped and impressions are still logged.

**Layer 2, embedding cache.** Query embeddings keyed on the normalized query, held in an in-process LRU of roughly 10,000 entries with the Postgres table as the shared backing store across service instances. This removes the GPU round trip from the majority of searches, which matters because that inference card also serves persona traffic and JSV work.

Expected effect: cached queries return in well under 100 ms, and Inference API calls from search drop by roughly two thirds.

### 13.8 Snippets

Use Postgres `ts_headline` on the lexical path. For results that arrived only through the vector path, return the best-matching chunk text truncated to roughly 200 characters at a sentence boundary. **Snippets are always extracted text, never generated.** Principle P7. The only hand-written prose in results is a best-bet `blurb`, authored by a human editor.

### 13.9 Thread continuation (R10)

For T1 results, if the page has `related_slugs` or shares `characters` with other indexed pages, render up to 3 "continue this thread" links beneath the result. Recurring characters and open threads already exist in the JubileeVerse frontmatter, so this costs a join, not a new pipeline. It turns search from an exit ramp into an entry point, which is much of the reason to run your own engine.

### 13.10 Latency budget (p95)

| Stage | Budget |
|---|---|
| Normalize, intent route, lexicon expansion | 15 ms |
| Best-bets lookup | 5 ms |
| Cache check | 5 ms |
| Query embedding (cache miss) | 60 ms |
| Zone A retrieval (lexical + vector) | 70 ms |
| Zone B retrieval (lexical + vector) | 80 ms |
| Fusion and boost, both zones | 15 ms |
| Rerank, both zones | 180 ms |
| Assembly and serialization | 30 ms |
| **Total, cache miss** | **~460 ms** |
| **Total, cache hit** | **< 100 ms** |

Reranking both zones is the largest single cost. If p95 breaches target under load, rerank Zone A only, since that is the block users read first, and drop Zone B to fusion order. Make this a runtime switch, not a code change.

---

## 14. Public API

All endpoints versioned under `/api/v1`.

```
GET  /api/v1/search
       ?q=            required, 1 to 256 chars
       &zones=        optional CSV: A,B  (default both)
       &tier=         optional CSV within Zone B: T2,T3
       &lang=         optional BCP-47
       &site=         optional host filter
       &category=     optional, T1 facet
       &persona=      optional, T1 facet
       &page=         default 1
       &size=         default 10, max 50
       &rerank=       default true
       &debug=        default false, requires admin right
     -> 200 {
          query, intent, took_ms, cache_hit,
          best_bets[], entity_panel|null, scripture_card|null,
          zone_a: { label, results[], coverage },
          zone_b: { label, results[], total_estimate },
          suggestions[], query_id
        }

GET  /api/v1/suggest?q=      typeahead: trigram + popular queries + entity aliases, <= 50 ms
POST /api/v1/event           { query_id, page_id, zone, position, type: 'click' }
POST /api/v1/report          { url, reason, note } abuse reporting
POST /api/v1/ingest/notify   publish-time push, HMAC signed
GET  /api/v1/health          service and index health
```

`debug=true` returns the full scoring breakdown per result: RRF components, each boost factor, rerank delta, and zone assignment reason. This is how principle P4 is satisfied in practice.

Admin endpoints sit under `/api/v1/admin/*` and require a Jubilee ID with the `search_admin` right, issued through the Jubilee SSO authority. Never a separate password system.

**Rate limiting:** 60 searches per minute per IP anonymous, 300 per minute for authenticated Jubilee ID sessions. Returns 429 with `Retry-After`.

**Embeddable widget:** a small JavaScript snippet other Jubilee sites drop in, calling `/api/v1/search` with a `site=` preset for local search and a toggle to widen to the whole network. In widget mode Zone A is the host site first, then the rest of the network, then Zone B. CORS allowlist restricted to registered Jubilee hosts.

---

## 15. Admin console

Screens required for v1:

1. **Dashboard.** Index size by tier, pages ingested and changed in the last 24 hours, webhook success rate, embedding backlog, safety queue depth, failed domains, p95 latency, cache hit rate, top queries, zero-result queries, Zone A coverage rate.
2. **Domains.** List, filter, add, edit, bulk import, verify ownership, set ingest mode and source root, force reingest, pause, purge.
3. **Lexicon editor.** Concepts and their terms grouped for editing, with language and weight per term, bulk import, and a live preview showing how a sample query expands. Enforces the Hebrew article validation rule.
4. **Best bets.** Create, schedule, reorder, deactivate, with a preview of the rendered block and a full audit log.
5. **Whitelist review.** Nominated domains awaiting T2 approval, with sample pages and an approve or reject decision recorded with reviewer and timestamp.
6. **Safety queue.** Pending reviews sorted by age, page text, machine verdict and reasons, and approve, reject, and block-domain actions.
7. **Blocklists.** Loaded sources, refresh status, manual entries.
8. **Search analytics.** Query volume by intent, Zone A versus Zone B click share, click-through rate by zone and position, zero-result queries, Zone A empty-state rate, query language distribution, lexicon concept hit rates.
9. **Ranking controls.** Live editing of all weights in Section 13.6, Zone A coverage thresholds, and cache time-to-live values, with a change log and one-click revert.
10. **Index tools.** Force reindex of a domain or page, purge, reembed, bump the cache version, and view the full ingest or crawl log for a given URL.

Access is by Jubilee ID with role rights. A view-only right exists alongside the admin right.

---

## 16. Ecosystem integration

| System | Integration |
|---|---|
| **Jubilee SSO** | Admin authentication and optional user sign-in on the public search page. Search itself never requires sign-in. |
| **Jubilee Analytics** | Two-way. Search emits standard page events outbound. Inbound, a nightly job pulls per-URL dwell, scroll depth, bounce, and completion for T1 pages and computes `engagement_score`, which feeds Zone A ranking (R8). This is only possible because Jubilee owns both systems, and it is a signal no external engine has. |
| **JubileePedia** | Source of truth for entity panels (R10). A sync job pulls entity summaries, facts, and canonical URLs into `entities`. Longer term, JubileePedia can also become the T1 markdown source root for the ingest service, at which point Section 9.1 needs no change at all, only a path update. |
| **Inference API** | Sole provider of embeddings, reranking, and safety classification. JubileeSearch runs no models of its own. Search embedding jobs run at low queue priority in an off-peak window, except publish-push chunks, which run at priority 1 but are tiny. |
| **JSV Bible** | Source for the scripture card (R3). Read-only, quoted verbatim. If the JSV API is unavailable, the card is omitted rather than approximated. |
| **JubileeVerse and the writing team** | Zero-result queries, Zone A empty-state queries, and low-CTR queries are exported weekly as a content-gap report. If people search for something the network does not answer, that is a writing assignment. |
| **Redirector Engine** | Outbound clicks on Zone B results may route through the redirector for click measurement. Zone A clicks go direct. |

That JubileeVerse row is where this project pays for itself twice over. Reader demand, measured rather than guessed.

---

## 17. Non-functional requirements

| Category | Requirement |
|---|---|
| Availability | 99.5% monthly for the search endpoint. Ingest and crawl services may be down without affecting search. |
| Search latency | p95 <= 500 ms on cache miss, p95 <= 100 ms on cache hit, p99 <= 900 ms |
| Cache hit rate | >= 50% steady state after 30 days of traffic |
| Index freshness | T1 changes searchable within 60 seconds via webhook, 24 hours via nightly reconciliation |
| Scale target v1 | 500,000 pages, 3 million chunks |
| Scale ceiling before re-architecture | roughly 20 million chunks in pgvector with HNSW. Past that, evaluate partitioning or Qdrant. |
| Storage estimate | at 1024-dim `halfvec`, roughly 2 KB per chunk vector plus text. 3 million chunks is on the order of 30 to 60 GB including text and indexes. Provision 250 GB with room to grow. No image storage at all. |
| Backups | Nightly full plus WAL archiving. Unlogged cache tables excluded. Restore drill quarterly, documented. |
| Observability | Structured JSON logs, per-service metrics, alerting on crawl failure rate, webhook failure rate, embedding backlog, safety queue depth, cache hit rate collapse, and latency breaches. |
| Security | Parameterized queries only. Admin endpoints behind SSO plus role check. HMAC on the ingest webhook with replay protection. Crawler runs with no database write access beyond its own tables. Fetched HTML never rendered in the admin console without sanitization. |
| Privacy | Query logs retain `jubilee_id` only where the user is signed in, and are purged or anonymized after 13 months. No cross-site behavioral profiles. Aggregate click learning only. |
| Legal | Honor robots.txt. Store extracted text for indexing and snippets only. Honor removal requests within 5 business days through a published contact. Publish a bot information page and a search privacy notice. |

---

## 18. Delivery phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Foundation** | Schema including lexicon, best-bets, and signal tables. Migrations, domain registry, admin skeleton, SSO auth. | All 130+ owned domains imported and ownership-verified as T1 |
| **2. T1 ingest** | Source-markdown ingest service (R5), publish webhook (R6), frontmatter mapping, dedupe, nightly reconciliation, crawl fallback | Full network ingested; a new article is searchable within 60 seconds; 95%+ of known article pages in `indexed` |
| **3. Search v1** | Lexical search, lexicon expansion (R2), best bets (R4), two-zone assembly (R1), public UI, impression and click logging (R7 logging only) | Keyword search across the network works end to end; Zone A and Zone B render correctly with coverage-aware sizing |
| **4. Semantic** | Chunking, embedding service, pgvector HNSW, hybrid fusion, rerank, caching (R9) | Gold-set evaluation shows hybrid beating lexical-only by a defined margin; cache hit rate above 40% |
| **5. Intelligence** | Intent router with scripture card (R3), click loop with position-bias correction (R7 activation), engagement scoring from Analytics (R8) | Scripture queries return the correct passage; CTR and engagement signals measurably move ranking on the gold set without regressing it |
| **6. Whitelist and open web** | T2 tier and approval workflow, trust-graph discovery, full safety pipeline, review queue, abuse reporting | 50+ approved faith-based domains indexed; 30-day audit shows a zero-tolerance safety pass rate on a sampled review |
| **7. Distribution and panels** | Embeddable widget, entity panels and thread continuation (R10), content-gap reporting to the writing team | Widget live on 5 or more Jubilee sites; weekly gap report delivered |

Phases 1 through 4 are the real product. Phase 5 is what makes it feel intelligent. Phases 6 and 7 are expansion and should not start until 1 through 4 are stable in production.

**Note on R7:** click and impression logging ships in Phase 3 even though the signal is not used until Phase 5. Data not collected is data that cannot be recovered.

---

## 19. Acceptance criteria

The build is accepted when all of the following are demonstrably true.

**Ingest and freshness**
1. Every registered T1 domain is ingested from source markdown where available, and the run is logged with pages processed, changed, and failed.
2. An article published on any Jubilee site is searchable within 60 seconds via webhook, verified end to end.
3. An unchanged page matches on `content_hash` and consumes no embedding compute.
4. Frontmatter fields (category, persona, office, tags, characters, related_slugs) are correctly populated on at least 99% of T1 pages, verified by sampling.
5. Robots.txt is provably honored on external domains, evidenced by a test against a controlled disallow rule.

**Search quality**
6. A gold set of at least 100 query and expected-result pairs is built from real Jubilee content, including at least 20 cross-register pairs and 15 cross-language pairs.
7. Hybrid retrieval achieves at least 85% recall at 10 on that gold set.
8. **Register bridging:** a query for "Holy Spirit" returns pages that use only "Ruach HaKodesh," and the reverse. Same for Jesus/Yeshua, God/Elohim, repentance/teshuvah. Zero failures on the 20 cross-register pairs.
9. **Cross-language:** Romanian and Hindi queries return correct results including English-language pages on the same concept.
10. Ten paraphrase queries sharing no keywords with their target document return the correct document in the top 5.

**Zones and presentation**
11. Zone A contains only verified T1 pages, proven by direct database query during review.
12. Zone A never renders below Zone B, in any client, at any viewport.
13. Zone A coverage sizing works: a query with weak Jubilee coverage shows fewer results or the honest empty state rather than padding to five.
14. Zone B is always labeled as wider-web content.
15. **No image appears in any result card at any tier**, verified across desktop and mobile rendering.

**Intelligence**
16. A scripture-reference query in any supported form returns the correct JSV passage in the card, and returns no card at all rather than a wrong passage when the reference cannot be resolved with certainty.
17. Best bets render above Zone A within 30 seconds of being created in the admin console.
18. Position-bias correction is implemented and demonstrably changes CTR ordering versus raw CTR on real logged data.
19. Engagement scores from Jubilee Analytics populate for at least 90% of T1 pages with traffic.

**Safety**
20. A test set of at least 200 known-unsafe URLs is classified with 100% rejection. Anything less than 100% blocks release of the T3 tier.
21. No T3 page is servable while its `safety_verdict` is anything other than `safe`, proven by direct database query.
22. Blocking a domain purges all of its pages from results within one job cycle.
23. Abuse reporting suppresses a page immediately and creates a review record.

**Operations**
24. p95 latency under 500 ms on cache miss and under 100 ms on cache hit, at 50 concurrent queries.
25. Cache hit rate above 50% after 30 days of production traffic.
26. `debug=true` returns a complete, correct scoring breakdown for every result.
27. Admin console counts match direct database counts.
28. A full restore from backup into a clean environment is performed and documented.

---

## 20. Decisions needed from Gabriel

| # | Decision | Needed by | Recommendation |
|---|---|---|---|
| D1 | Which Postgres instance hosts this? Shared with Jubilee Analytics on the InspireManna database, or its own? | Phase 1 | **Own instance.** Ingest write load and vector index memory will contend badly with analytics ingest. Same technology, separate server. |
| D2 | Web front-end stack for the public search page | Phase 3 | Match the network standard. The API is language-neutral, so this is a team-skills decision. |
| D3 | Doctrinal filtering posture (Section 11.4) | Phase 6 | Human editorial control at the T2 whitelist only, with Zone B clearly labeled. No automated doctrine classifier. |
| D4 | Who owns the safety review queue day to day? | Phase 6 | A named person with a 48-hour service commitment, not "the team." Without an owner the queue becomes the bottleneck that stalls the entire T3 tier. |
| D5 | Where does the T1 source markdown actually live, and what is the canonical path structure per domain? | **Phase 2, blocking** | Needed to build the ingest service at all. If it is CDN paths today and JubileePedia later, give me both and the mapper will handle the transition. |
| D6 | Initial T2 whitelist seed list, 30 to 50 domains | Phase 6 | Editorial artifact, cannot be delegated to the developer. |
| D7 | Bot contact email for the public bot page and removal requests | Phase 2 | Needed before the first external crawl. |
| D8 | Is the RTX PRO 6000 cleared to take ingest-time embedding batches alongside persona traffic? | Phase 4 | Off-peak window at low queue priority, with publish-push as the only priority-1 exception. |
| D9 | **Seed lexicon authorship** (Section 13.3) | **Phase 3, blocking** | 60 to 100 concepts covering divine names, core Hebrew concepts, feasts, and Romanian and Hindi pairs. This is the single highest-value artifact only Jubilee can produce, and search quality on your own content depends on it directly. |
| D10 | Zone A coverage thresholds and the minimum relevance floor | Phase 3 | Start conservative with a high floor. Better to show two strong Jubilee results than five weak ones. Tune from real traffic after 30 days. |
| D11 | Publishing systems that will emit the ingest webhook, and who owns wiring each one | Phase 2 | Name the systems now. The webhook is worthless if only one property fires it. |

---

## 21. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| An unsafe page reaches public results | Medium | **Severe.** Reputational damage to a ministry brand. | Default deny, five gates, abuse reporting, weekly audit sample, aggressive domain-level blocking. Risk materially reduced by removing images from scope. |
| Zone A becomes noise because the relevance floor is too low | **High** | High | Coverage-aware sizing, honest empty state, monitored Zone A click share. If Zone A CTR falls below Zone B CTR, the floor is wrong and must be raised immediately. |
| Seed lexicon never gets written, so register bridging never works | High | High | D9 is blocking on Phase 3. Ship a minimum 60-concept set before search goes live rather than after. |
| Webhooks fail silently and content goes stale | Medium | Medium | Nightly reconciliation is mandatory and never removed. Webhook success rate is a dashboard metric with alerting. |
| Click loop learns from thin data and produces bad ranking | Medium | Medium | Confidence shrinkage on low volume, position-bias correction, and a `w_ctr` weight that can be set to zero at runtime |
| Safety review queue is never worked, stalling T3 | High | Medium | Named owner (D4), queue-depth alerting, hard rule that T3 launch waits on staffing |
| Embedding model changed mid-build, forcing full reindex | Medium | Medium | Lock the model before Phase 4. `model_id` per chunk makes migration rolling. |
| Crawler gets Jubilee IPs blocked by external hosts | Medium | Medium | Honest user agent, robots compliance, conservative rate limits, public bot page, prompt response to complaints |
| pgvector performance degrades past 20 million chunks | Low in v1 | Medium | Documented ceiling, Qdrant identified as fallback, monitoring in place before it is needed |
| Scope creep into an AI answer engine before search works | **High** | High | Principle P7. No generated answers. Revisit only after Phase 5 is stable in production. |
| Scope creep back into image results | Medium | Medium | Principle P10 and Section 2.2. Image search is out of scope, not deferred. Any request to add it is a new project with its own safety design. |
| Search competes for the same GPU as persona and JSV work | High | Medium | Off-peak batch windows, low queue priority, and the embedding cache removing most query-time GPU calls |

---

## Appendix A: Reference queries

**A.1 Zone A retrieval (T1 only), hybrid with signal boost**

```sql
WITH lexical AS (
    SELECT p.id AS page_id,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(p.body_tsv, q) DESC) AS rank
    FROM pages p, websearch_to_tsquery('english', $1) q   -- $1 = expanded query
    WHERE p.body_tsv @@ q
      AND p.status = 'indexed'
      AND p.tier = 'T1'
    ORDER BY ts_rank_cd(p.body_tsv, q) DESC
    LIMIT 100
),
semantic AS (
    SELECT c.page_id,
           ROW_NUMBER() OVER (ORDER BY c.embedding <=> $2::halfvec) AS rank
    FROM chunks c
    JOIN pages p ON p.id = c.page_id
    WHERE p.status = 'indexed'
      AND p.tier = 'T1'
    ORDER BY c.embedding <=> $2::halfvec
    LIMIT 100
),
fused AS (
    SELECT COALESCE(l.page_id, s.page_id) AS page_id,
           COALESCE(1.0 / (60 + l.rank), 0) + COALESCE(1.0 / (60 + s.rank), 0) AS rrf
    FROM lexical l
    FULL OUTER JOIN semantic s ON l.page_id = s.page_id
)
SELECT p.id, p.url, p.title, p.description, p.category, p.persona, p.related_slugs,
       f.rrf
         * (1 + 0.15 * COALESCE(p.quality_score,0)/100)
         * (1 + 0.20 * COALESCE(p.engagement_score,0)/100)
         * (1 + 0.25 * COALESCE(ctr.corrected_ctr,0) * COALESCE(ctr.confidence,0))
         * (1 + 0.20 * (CASE WHEN p.language = $3 THEN 1 ELSE 0 END))
       AS score
FROM fused f
JOIN pages p ON p.id = f.page_id
LEFT JOIN query_page_ctr ctr
       ON ctr.page_id = p.id AND ctr.normalized_query = $4
ORDER BY score DESC
LIMIT 50;   -- rerank these, then take 3 to 5 by coverage rule
```

Zone B uses the same shape with `p.tier IN ('T2','T3')` and the Zone B signal set from Section 13.6.

**A.2 Lexicon expansion lookup**

```sql
SELECT DISTINCT t2.term, t2.weight, c.concept_key
FROM lexicon_terms t1
JOIN lexicon_concepts c ON c.id = t1.concept_id AND c.active
JOIN lexicon_terms t2 ON t2.concept_id = t1.concept_id
WHERE t1.term = ANY($1::text[])          -- normalized query tokens and bigrams
  AND (t2.lang = $2 OR t2.lang = 'en')
  AND t2.term <> t1.term;
```

**A.3 Position-bias corrected CTR (nightly rollup)**

```sql
INSERT INTO query_page_ctr (normalized_query, page_id, impressions, clicks,
                            raw_ctr, corrected_ctr, confidence, updated_at)
SELECT sq.normalized,
       ri.page_id,
       COUNT(*) AS impressions,
       COUNT(*) FILTER (WHERE ri.clicked) AS clicks,
       COUNT(*) FILTER (WHERE ri.clicked)::numeric / COUNT(*) AS raw_ctr,
       SUM(CASE WHEN ri.clicked THEN 1.0 / pb.examination_prob ELSE 0 END)
         / NULLIF(SUM(1.0 / pb.examination_prob), 0) AS corrected_ctr,
       LEAST(COUNT(*)::numeric / 50.0, 1.0) AS confidence,  -- full trust at 50 impressions
       now()
FROM result_impressions ri
JOIN search_queries sq ON sq.id = ri.query_id
JOIN position_bias pb ON pb.zone = ri.zone AND pb.position = ri.position
WHERE sq.created_at >= now() - INTERVAL '90 days'
GROUP BY sq.normalized, ri.page_id
HAVING COUNT(*) >= 5
ON CONFLICT (normalized_query, page_id) DO UPDATE
   SET impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks,
       raw_ctr = EXCLUDED.raw_ctr,
       corrected_ctr = EXCLUDED.corrected_ctr,
       confidence = EXCLUDED.confidence,
       updated_at = now();
```

`position_bias.examination_prob` is seeded with a reasonable decay curve and later re-estimated from real data once traffic supports it. Seeding it is fine; leaving it unmeasured forever is not.

---

## Appendix B: Glossary

| Term | Meaning |
|---|---|
| Chunk | A passage of a page, embedded as one vector |
| Frontier | The set of URLs scheduled to be fetched |
| HNSW | Hierarchical Navigable Small World, the approximate nearest-neighbor index used by pgvector |
| RRF | Reciprocal Rank Fusion, the method for merging two ranked lists without score normalization |
| Tier | Trust classification of a domain and its pages, T0 through T3 |
| Zone | A structurally separate results block. Zone A is Jubilee, Zone B is the wider web. |
| Gold set | A fixed set of queries with known correct answers, used to measure search quality across changes |
| Position bias | The tendency of users to click higher-ranked results regardless of relevance, which must be corrected before click data is used as a ranking signal |
| Coverage | How well the Jubilee network answers a given query, which determines Zone A sizing |

---

## Appendix C: Recommendation traceability

| Ref | Recommendation | Where it lives |
|---|---|---|
| R1 | Two-zone results | P8, Section 4, 13.1, 13.5, 13.6, API response shape, acceptance 11 to 14 |
| R2 | Register and language bridge lexicon | 7.5, 13.3, admin screen 3, D9, acceptance 8 and 9 |
| R3 | Query intent router with scripture card | 7.7 `intent`, 13.2, Section 16 JSV row, acceptance 16 |
| R4 | Editorial best bets | 7.6, 13.4, admin screen 4, acceptance 17 |
| R5 | Source markdown ingest for T1 | 6.1, 7.1 `ingest_mode`, 9.1, 12.1, D5, acceptance 1 and 4 |
| R6 | Publish-time push | 9.2, API `/ingest/notify`, D11, acceptance 2 |
| R7 | Click loop with position-bias correction | 7.7, 13.6, Appendix A.3, phase note, acceptance 18 |
| R8 | Engagement-driven quality from Jubilee Analytics | 7.7 `page_engagement`, 13.6, Section 16, acceptance 19 |
| R9 | Two-layer cache | 7.9, 13.7, NFR cache hit rate, acceptance 24 and 25 |
| R10 | Entity panels and thread continuation | 7.8, 13.2, 13.9, Section 16 JubileePedia row, Phase 7 |
| — | Image results removed | Section 2.2, P10, 11.2, 9.4, acceptance 15, risk register |

---

*End of specification.*
