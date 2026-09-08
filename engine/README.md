# JubileeSearch engine

The index, the ingest services and the search API behind jubileesearch.com.

Implements `setup/initial_setup.md` v1.1 (3 September 2026). Section references
throughout this file and in the source point at that document, which is the
specification and the arbiter of anything this README and the code disagree on.

---

## What is built

| Phase (§18) | Deliverable | State |
|---|---|---|
| **1. Foundation** | Schema, migrations, domain registry, admin API, SSO auth | **built** |
| **2. T1 ingest** | Source-markdown ingest, publish webhook, frontmatter mapping, dedupe, nightly reconciliation | **built** — blocked on **D5** to run |
| **3. Search v1** | Lexical search, lexicon expansion, best bets, two-zone assembly, public UI, impression and click logging | **built** — lexicon is a starter seed pending **D9** |
| **4. Semantic** | Chunking, embedding service, pgvector HNSW, hybrid fusion, rerank, two-layer cache | **built** — needs the Inference API wired up |
| **5. Intelligence** | Intent router with scripture card, click loop with position-bias correction, engagement scoring | **built** — cards need the JSV API, engagement needs Analytics |
| **6. Whitelist and open web** | T2 approval workflow, trust-graph discovery, full safety pipeline, crawler, review queue, abuse reporting | **built** — the blocklist sources ship disabled pending verification |
| **7. Distribution and panels** | Embeddable widget, entity panels, thread continuation, content-gap reporting | **built** — the JubileePedia sync needs a URL to pull from |

Still not built:

* **The admin console UI.** All ten screens' APIs exist; there are no pages. Two
  acceptance criteria (17 and 27) cannot be demonstrated without it, and the
  safety queue has no interface for the owner decision D4 is about.
* **Headless rendering.** `render_js` is honoured to the extent that the fetcher
  refuses the page and says why, rather than indexing an empty shell. §9.4 wants
  it off by default anyway.
* **A real language-detection model.** `src/text/normalize.js` is a script and
  stopword heuristic and says so where it matters.

---

## Decisions still needed (§20)

Two are marked blocking in the specification and both are still open. They are
not developer decisions and the build cannot make them for Jubilee.

**D5 — where the T1 source markdown lives, and the canonical path structure per
domain.** *Blocking on Phase 2.* Every T1 domain is seeded with
`source_root = NULL`, so `npm run ingest` reports that and does nothing.
`src/ingest/source.js` already handles both shapes the answer could take (a CDN
URL or a filesystem path) and both can coexist per domain, so the answer should
only need setting `domains.source_root` and `domains.url_template`.

**D9 — seed lexicon authorship.** *Blocking on Phase 3.* Migration 023 seeds 46
starter concepts so the expansion path can be exercised and acceptance criterion
8 can be tested. It says at the top that it does not discharge D9, and it means
it: the choice between Yahuah, Yahweh and the LORD on a given property is
editorial, and search quality on Jubilee's own content depends on it more
directly than on any ranking weight.

Also open and worth naming: **D7** (bot contact email — needed before the first
external crawl; the placeholder is in `bot.html` and `.env`), **D10** (Zone A
coverage thresholds — seeded conservatively per the recommendation, tune from
traffic after 30 days), **D11** (which publishing systems emit the webhook).

---

## Where it runs

**Postgres 16 or 17 with `pgvector` >= 0.7.** The version floor is checked by
migration 001 and is not advisory: `halfvec(1024)` does not exist before 0.7, and
the whole chunk table is built on it.

On this workstation the database is a schema inside the existing
`pgvector/pgvector:pg17` container (`inspirecortex-postgres`, host port 5433).
In production, decision D1 recommends its own instance rather than sharing the
InspireManna database with Jubilee Analytics: ingest write load and HNSW index
memory contend badly with analytics ingest.

**The API** runs on port 4038, which `ops/config/cloudflare-config.yml` already
maps `api.jubileesearch.com` to.

### Node, not Python

§6.1 picks FastAPI. This is Node, and the reason is worth recording rather than
discovering later:

* §16 puts every model behind the Jubilee Inference API — "JubileeSearch runs no
  models of its own." The stated rationale for Python was "same language as the
  ML stack, so no cross-language model serving", and there is no local ML stack
  to be the same language as. Every model call in this engine is an HTTP request.
* `ops/config/websites-services.json` already registers JubileeSearch as a Node
  app (`server.cjs`, port 3038), and the prior engine work was Node.
* §6.2 anticipates the swap on the crawl side: Crawlee "if the team is stronger
  in TypeScript than Python."

If the offshore team is stronger in Python, the port is a real cost but not a
large one — the SQL is the substance of this build, and it is unchanged.

---

## Running it

### On localhost, with no Postgres installed

The fastest way to see the whole thing work. PGlite is Postgres compiled to
WASM — the real planner, the real type system, real pgvector — running in
process with nothing to install. `src/db-pglite.js` says what it is not.

```bash
cd engine
npm install

export USE_PGLITE=1 PGLITE_DIR=.pglite-dev NODE_ENV=development ALLOW_INSECURE_ADMIN=true
npm run migrate          # applies all migrations to the WASM database
npm run dev:seed         # verifies the T1 domains and ingests ~25 pages

npm start                # API  -> http://localhost:4038
npm run site             # site -> http://localhost:8080   (second terminal)
```

Then <http://localhost:8080/search?q=holy+spirit>. The dev content is derived
from `setup/initial_setup.md`, one page per section — real text from the
repository rather than invented articles, and it happens to contain both
registers, so register bridging is visible on the first query you try.

Two things will be missing and both say so rather than failing: there is no
Inference API, so retrieval is lexical-only with no rerank; and no JSV API, so a
scripture query routes correctly and renders no card.

**One connection.** PGlite is single-writer, so the API server holds
`.pglite-dev` exclusively. `npm run admin` and the jobs need the server stopped
first, or their own `PGLITE_DIR`.

### Against a real Postgres

```bash
npm run migrate          # applies db/migrations in order, each in a transaction
npm test                 # 224 tests
npm start                # API on :4038
```

Then grant Zone A eligibility. It is deliberately not something a seed file does:

```bash
npm run admin -- domains list
npm run admin -- domains verify --all --method=authoritative_list --actor=<your-jubilee-id>
npm run admin -- check   # the acceptance criteria the database can answer
```

Jobs, for the systemd timers:

```bash
npm run ingest           # nightly source ingest and reconciliation (§9.1, §9.2)
npm run crawl            # the crawl worker; --seed to (re)seed from sitemaps first
npm run discover         # trust-graph nomination and probe promotion (§10.2)
npm run embed            # embedding backfill; --publish-only for the priority-1 path
npm run ctr-rollup       # nightly click rollup; --compare prints acceptance 18's evidence
npm run engagement       # quality recompute plus the Analytics pull (R8)
npm run entities         # JubileePedia entity sync for the panels (R10)
npm run blocklists       # refresh gate-1 blocklists; --dry-run parses without writing
```

`npm run discover` is weekly work, not hourly: it is a query over links the
crawler already recorded, so it costs no requests, and the link graph does not
change meaningfully between two crawls of the same site. Run
`npm run discover -- --dry-run` first on a real graph — it shows what the
threshold would nominate without writing a candidate row.

`npm run crawl` takes `--host=`, `--tier=`, `--max=` and `--seed`. Start narrow
and watch what comes back:

```bash
npm run crawl -- --host=jubileeverse.com --seed --max=20
npm run admin -- check
```

Several workers can run at once. The queue is claimed with
`FOR UPDATE SKIP LOCKED`, so they do not need to know about each other — but the
politeness lock is per process, so partition by host (`--host=`) rather than
running two unrestricted workers, or the same site will see both of them.

---

## How the pieces fit

```
  GET /api/v1/search
        |
  src/query/orchestrator.js        the eight steps of §13.1, in order
        |
        +-- text/normalize.js      [1] normalise  [2] detect language
        +-- query/intent.js        [3] route          -> text/scripture.js
        +-- query/lexicon.js       [4] expand         (R2)
        +-- query/bestbets.js      [5] pinned block   (R4)
        +-- query/cache.js         [6] result cache, then embedding cache (R9)
        +-- query/retrieval.js     [7] two zones, RRF, signal boost
        +-- query/coverage.js          coverage sizing and host diversity
        +-- query/panels.js            scripture card, entity panel, threads
        +-- inference/client.js        embeddings, rerank, safety classification
        |
        +-- [8] impressions logged, in both the cache-hit and cache-miss paths
```

Ingest is the mirror image: `ingest/source.js` reads, `ingest/markdown.js` maps
frontmatter to columns, `ingest/chunker.js` cuts on heading boundaries, and
`ingest/service.js` writes — stopping at the `content_hash` comparison whenever
the page has not changed, which is what keeps a nightly run over the whole owned
network cheap.

The crawl path is the third way in, and it converges on the same two writers:

```
  src/jobs/crawl.js
        |
        +-- crawl/frontier.js      due domains, sitemap seeding, claim, backoff
        |     +-- crawl/sitemap.js     sitemap, sitemap index, RSS, Atom
        |     +-- crawl/policy.js      what may enter the frontier at all
        |
        +-- crawl/fetcher.js       robots, conditional GET, politeness, caps
        |     +-- crawl/robots.js      RFC 9309 parsing and matching
        |
        +-- crawl/extractor.js     boilerplate removal, metadata, links
        |     +-- crawl/pdf.js         text-layer only, no OCR
        |
        +-- safety/gates.js        five gates, default deny
        +-- crawl/store.js         write the page, its links, its SimHash
              +-- crawl/simhash.js     near-duplicate clustering
              +-- ingest/chunker.js    the same chunker the markdown path uses
```

That last line is deliberate. `crawl/extractor.js` emits **markdown**, not plain
text, so a crawled page splits on heading boundaries through exactly the same
chunker as a source-markdown page (§12.1) instead of needing a second, worse one.

### How a domain gets into the open-web tier

`crawl/discovery.js`, and every step is a gate rather than a stage:

```
  nominate   >= 3 distinct T1/T2 domains link to a host        §10.2
             (nofollow does not count -- that is the linking
              site declining to vouch)
  screen     gate 1, domain reputation, before one request     §11.1
  probe      enters the registry at T0 with a 20-page cap;     §10.2
             T0 is excluded from servable_pages, so nothing
             it holds can reach a reader
  promote    a >=90% pass rate on the sample moves it to T3;
             anything less is rejected and purged
```

Nothing in that pipeline fetches anything. Discovery is a query over links the
crawler already recorded, which is what §10.1 means by "the web's own link
structure does the discovery work" — and by "**Do not attempt a broad web
crawl.**"

A **T2** nomination skips the first two steps entirely and goes to a person,
because §11.4 puts doctrinal judgement there and nowhere else. Both kinds share
one queue (`domain_candidates`, told apart by `target_tier`) so there is one
review surface rather than two that drift apart.

---

## The parts that are structural, not conventional

A few guarantees are enforced by the schema rather than by discipline, because
the specification requires them to be provable and because a `WHERE` clause is
only as good as the next person who forgets to write it.

**`servable_pages` is the only page source the query pipeline reads.** It
encodes P1, default deny: T1 is trusted, T2 must not be classified unsafe, T3
must carry `safety_verdict = 'safe'`, and T0 is never served at all. A crawl that
outruns the classifier therefore returns nothing rather than something unchecked,
and acceptance criterion 21 is a `SELECT` against the view.

**`zone_a_pages` is verified-T1-only, and Zone A reads only that.** P8 makes
Zone A a structural guarantee rather than a scoring outcome, so no ranking change
can leak an external page into it (acceptance 11). The matching constraint
`domains_zone_a_requires_t1` means the flag cannot be set on a non-T1 domain in
the first place.

**There is no tier multiplier anywhere in `retrieval.js`.** R1 replaced the
cross-tier comparison with two separate retrievals; the two zones never meet
until assembly. Reintroducing a multiplier would be reintroducing the problem.

**`lexicon_terms_no_doubled_article`** is a CHECK constraint, because §13.3 calls
the Hebrew article rule "a validation rule in the lexicon editor, not a style
suggestion".

**No image is fetched, stored, or rendered, at any tier.** P10 is enforced at
four separate points, because one of them will eventually be edited by someone
who does not know about the other three: `crawl/policy.js` refuses image
extensions before a URL can enter the frontier; the fetcher refuses `image/*` on
Content-Type without reading the body; `crawl/store.js` keeps `og_image_url` on
T1 only and discards it for T2 and T3, per §9.4; and nothing in `src/query/`
selects it. The favicon `<img>` the old front end loaded per result is gone, and
`css/styles.css` says why where the rule used to be.

**The widget cannot drop Zone B's label or reorder the zones.** It runs on other
people's pages, and acceptance criteria 12 and 14 say "in any client" — so
`src/api/widget/widget.js` builds the markup itself rather than handing results
over as data for the host site to lay out. It renders into a shadow root, which
also means neither side's CSS can reach the other, and it contains no `<img>` at
any tier. `prefer_site` reorders Zone A to put the host site first (§14) and can
never admit a page retrieval did not already return.

**A robots.txt refusal costs zero requests.** `robots_denied` is decided before
the fetch, from a cached robots.txt, and `test/fetcher.test.js` asserts that the
request count does not move. That is the substance of acceptance criterion 5 —
not that a refusal is recorded, but that nothing was requested — and every
refusal is written to `crawl_failures` with the rule that caused it, so the
evidence is a query rather than a log grep.

**An unreachable robots.txt means stop, not carry on.** RFC 9309 makes a 5xx a
complete disallow while a 404 is an allow-all, and the asymmetry is deliberate:
a 5xx is a site failing to answer, and assuming "allowed" against a failing
server is exactly when a crawler does the most damage. The refusal is marked
retryable so a bad minute does not become a permanent verdict.

---

## Deviations from the specification, and why

Each of these is a deliberate departure. None of them changes a stated
requirement; they are places where following the text literally would have
produced something that does not meet it.

**Normalisation produces two strings, not one.** §13.1 step 1 strips
punctuation, but the intent router in §13.2 has to match `john 3:16`, and
`john 316` is not a reference any regex recovers. `normalize()` returns
`normalized` (fully stripped, used for lexical matching, the cache key and the
CTR rollup) and `routable` (colons and hyphens intact, used only by the router).

**The lexical query is several tsqueries, not one.** Appendix A.1 passes one
expanded string to `websearch_to_tsquery`, which cannot express the per-term
weights §13.3 step 4 requires. Retrieval instead scores
`ts_rank_cd(tsv, original) + Σ weightᵢ · ts_rank_cd(tsv, groupᵢ)`, one group per
distinct weight — two or three in practice.

**The HNSW index is split in two along the zone boundary** (migration 011).
§7.3 gives one index over all chunks. With one index, "top 100 nearest T1
chunks" walks a graph that is mostly T2 and T3 and then discards, so at the v1
scale target a Zone A search can return far fewer than 100 T1 chunks. `tier` is
denormalised onto `chunks` by trigger and there are two partial indexes.
Servability is still post-filtered, which is why retrieval over-fetches.

**The semantic CTE takes the best chunk per page.** Appendix A.1 ranks chunks
and then full-outer-joins on `page_id`, which multiplies rows when a page
contributes several chunks. `DISTINCT ON (page_id)` picks the nearest one first.

**The webhook signature is header-based.** §9.2's example puts `signature`
inside the JSON body, which is circular and carries no timestamp to enforce the
five-minute window against. The canonical scheme is
`X-Jubilee-Timestamp` plus `X-Jubilee-Signature` over `"<timestamp>.<raw body>"`;
the in-body form is still accepted for compatibility, but only with an
`issued_at`, because without one the request is replayable forever.

**There is no `/api/search/web` compatibility shim.** The old endpoint returned
one blended list, and acceptance criterion 12 requires Zone A above Zone B "in
any client". A flat list cannot express that. `js/app.js` was moved to
`/api/v1/search` instead.

**SearXNG is retired.** It is in `legacy-v0/` with a full explanation. Short
version: metasearch results have no `pages` row, so they cannot be gated by
`servable_pages`, logged as impressions, reported, or purged — they would arrive
already past the one control P1 exists to impose.

**Ranking config, index versioning, webhook secrets and a few other operational
tables** are in migration 009 rather than 002–008, so that 002–008 stay verbatim
against §7 and can be diffed against the document.

**Content extraction is the readability heuristic, not Trafilatura.** §6.1 picks
Trafilatura and Trafilatura is better: it has been benchmarked against a corpus,
and this has not. There is no Node equivalent worth a heavy dependency, and
`readability-lxml` — the specification's own named fallback — is this same
heuristic. Where it will be worse: pages that interleave content and furniture
inside one container. If extraction quality shows up as a recall problem on the
gold set, the escape hatch is running Trafilatura as a sidecar and calling it
over HTTP, which changes nothing else. `src/crawl/extractor.js` says all of this
at the top, where someone debugging a bad extraction will read it.

**PDF extraction reads the text layer and refuses everything else.** §9.5 asks
for text-layer extraction with no OCR, and that is what `crawl/pdf.js` does:
inflate the content streams, read the text-showing operators. It does not
implement font descriptors, so a CID-font PDF decodes to bytes rather than
words — and `looksLikeText` catches that and returns `no_text_layer`, which is
the same outcome the specification prescribes for a scan. Indexing mojibake
would be worse than indexing nothing: it tokenises into terms that match no
query and sit in the tsvector forever.

**Near-duplicate detection uses SimHash rather than MinHash**, which §9.6 allows
either of. SimHash stores as one 64-bit integer and its candidate lookup is four
equality probes against banded columns; a MinHash signature is dozens of values.
At this corpus size the accuracy difference does not pay for the storage
difference. The four-band index is a pigeonhole argument that only holds to a
Hamming distance of 3, which is why `near_duplicate_max_distance` is documented
as breaking the index above 3 rather than as a knob to turn.

---

## Migrations

`002` through `008` reproduce §7's DDL as written; the specification calls it the
normative contract and says column names are binding, so they are not rewritten
with `IF NOT EXISTS` decoration. Idempotency comes from the `schema_migrations`
ledger instead.

| | |
|---|---|
| `001_extensions` | pgvector version floor, `pg_trgm`, `unaccent`, `pgcrypto` |
| `002_core` | domains, pages, chunks (§7.1–7.3) |
| `003_crawl_safety` | crawl queue, links, blocklists, review queue (§7.4) |
| `004_lexicon` | concepts and terms, plus the doubled-article constraint (§7.5) |
| `005_best_bets` | pins and their audit log (§7.6) |
| `006_signals` | queries, impressions, CTR rollup, position bias, engagement (§7.7) |
| `007_entities` | entity panels (§7.8) |
| `008_cache` | unlogged result and embedding caches (§7.9) |
| `009_operational` | ranking config, index version, webhook secrets, abuse reports, ingest runs |
| `010_triggers_views` | `body_tsv` trigger, and the `servable_pages` / `zone_a_pages` gate |
| `011_chunk_zone_index` | the split HNSW index |
| `012_embed_attempts` | embedding retry bookkeeping (§12.2) |
| `013_near_duplicates` | SimHash columns, banded index, and `duplicate_of` (§9.6) |
| `014_crawl_state` | adaptive-backoff counter and the `crawl_failures` record (§9.3, §9.4) |
| `015_discovery` | `domain_candidates`, `links.to_host`, blocklist load history (§10.2, §15) |
| `020`–`024` | seeds: 56 owned domains, position bias, ranking config, starter lexicon, blocklist |

The v0 schema is in `legacy-v0/db/` with a note on why it could not be migrated
forward: it has no tier, no chunks, and a `media` table that §11.2 says must not
exist.

---

## Testing

```bash
npm test
```

224 tests. None of them needs a database.

Most are over code that does no I/O at all — normalisation, scripture reference
parsing and its refusals, the intent router, Zone A coverage sizing, host
diversity, tsquery construction, frontmatter mapping, markdown stripping,
chunking, URL canonicalisation, webhook signatures, source-path traversal,
engagement scoring, rate limiting, robots.txt matching, URL admission, sitemap
and feed parsing, HTML extraction, SimHash clustering, PDF text layers, and
backoff.

`test/fetcher.test.js` is the exception and the only end-to-end evidence in the
suite: it starts a real HTTP server and drives the fetcher against it, because
the behaviours §9.4 specifies are behaviours of an HTTP client and cannot be
checked by calling a function with a string. It covers the conditional GET
returning 304, the body cap enforced both from `Content-Length` and mid-stream,
`image/*` refused without reading the body, a robots refusal costing zero
requests, `Retry-After`, and the per-host politeness delay holding under three
concurrent calls.

Two of the bugs in this build were caught by those tests rather than by reading:
an RSS `<link>` (text) parsed only in its Atom form (attribute), which silently
returned zero entries for every RSS feed; and backoff jitter applied after the
cap, so the documented 10-minute ceiling could be exceeded by half.

`npm run admin -- check` covers the acceptance criteria that are database
questions: Zone A purity (11), T3 servability (21), blocked-domain purge (22),
abuse suppression (23), chunk provenance, and the lexicon constraint. It also
prints the Zone A versus Zone B CTR comparison, which the risk register makes the
tripwire for the relevance floor.

### The SQL, and what has actually run

`test/database.test.js` applies every migration to an in-memory PGlite and then
exercises the schema and the query pipeline: the serving views refusing an
unsafe T3 page, the two CHECK constraints rejecting at write time, the ranking
weights surviving parameter binding, register bridging in both directions, the
honest empty state, impression logging on both the cache-miss and cache-hit
paths, the CTR rollup, and `simhash_distance` agreeing with its JavaScript
counterpart. It runs on every `npm test`.

That is PostgreSQL 18 with pgvector 0.8.1, so the DDL, the functions, the
triggers, the views and the seeds are all genuinely executed. Two bugs came out
of doing it that no amount of reading had found:

* `/suggest` ordered a `UNION ALL` by an expression. Postgres allows only output
  column names or ordinals there and rejects the query outright.
* the retrieval query's numeric bind parameters resolved against `integer`, so a
  weight of `0.15` was rejected. Every one now carries an explicit cast.

**It is still not a substitute for real Postgres before release.** PGlite is one
connection, so `FOR UPDATE SKIP LOCKED` cannot be shown to do its job; nothing
operational is exercised; and `UNLOGGED` is meaningless in memory. The remaining
places a first `npm run migrate` against a real server could still surprise you:

* **Version.** PGlite here is PostgreSQL 18; the specification requires 16 or 17.
  The direction is the awkward one — something that parses on 18 could fail on
  16. `bit_count(bit)` in 013 is the function to check first; it needs 14 or
  newer, so it should be fine, but it is the one version floor migration 001 does
  not assert.
* **pgvector version.** Verified against 0.8.1. Migration 001 refuses anything
  below 0.7, which is the floor `halfvec` needs.
* **The driver.** The tests go through the PGlite adapter, which coerces Buffers
  and BigInts on the way in (`src/db-pglite.js`). Real `pg` handles `bytea` and
  arrays its own way, so `content_hash`, `url_hash` and the `text[]` columns are
  the first things to confirm round-trip correctly.
* **Concurrency.** `FOR UPDATE SKIP LOCKED` in the crawl queue and the embedding
  job cannot be demonstrated on one connection. Run two crawl workers against
  real Postgres and confirm they do not both claim the same URL.
* **Index selection.** PGlite holds a handful of rows, so every query is a
  sequential scan and the plans prove nothing. Whether the planner reaches for
  `chunks_embedding_zone_a` and the GIN index on `body_tsv` at three million
  chunks is a question only a real corpus answers — and §17's p95 budget depends
  on the answer.
* **`UNLOGGED`.** Meaningless in memory. The cache tables' whole point is
  skipping the WAL.

### What no test here can cover

Phase 3 and 4 sign-off will need: the gold set of 100+ query and expected-result
pairs (acceptance 6), including the 20 cross-register and 15 cross-language
pairs; the 200 known-unsafe URLs (acceptance 20); latency under 50 concurrent
queries (24); and the restore drill (28). Those need a corpus, a load generator,
and content that does not exist yet.

Extraction quality is the other one. A local server serving a page this build
wrote proves the pipeline runs; it proves nothing about how the scoring
heuristic behaves on a real ministry site with a share widget in the middle of
the article. That wants a sample of thirty or so pages from the intended T2
whitelist, extracted and read by a person. Do it before the whitelist is
approved, not after — it is also the cheapest way to find out whether
Trafilatura needs to come back.

---

## Before the first external crawl

§9.4 requires the bot page to exist first. `bot.html` is at the repository root,
and it needs an nginx rewrite from `/bot`, because the user agent string is fixed
by the specification as
`JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)`:

```nginx
location = /bot    { try_files /bot.html =404; }
location = /search { try_files /search.html =404; }
```

The second line fixes a live bug: the home page form posts to `/search`, which
the server currently 404s. The form actions have been pointed at `/search.html`
so the site works without the rewrite, but the clean URL is worth having.

The bot page also carries the D7 placeholder. Do not crawl anything external
until there is a real address on it.
