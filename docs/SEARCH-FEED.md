# The JubileeSearch content feed

How a Jubilee site hands its content to search.

---

## Why a feed and not a crawler

JubileeSearch has a working crawler, a robots-aware fetcher, and headless
rendering. None of them can index JubileeVerse, and the reason is worth stating
because it is not a bug in either system:

| | finding |
| --- | --- |
| Article text in the served HTML | **absent** — bodies are fetched client-side |
| Article text in the RSC flight payload | **absent** — searched, not there |
| Article links in the markup | **absent** — cards are `<div class="content-card">` with click handlers, no `<a href>` |
| Article links after headless rendering | **still absent** — the rendered page exposes 18 links, none an article |
| `/sitemap.xml` | returns the SPA shell, not XML |

Headless rendering was implemented (`engine/src/crawl/render.js`) and does not
help, because the missing piece is **discovery**, not JavaScript. There is no
URL for a crawler to follow.

A feed is also the better arrangement for the publisher. The site decides what
is searchable, in a shape it controls, and a front-end redesign can no longer
silently empty the search index — which a markup-dependent crawler risks on
every deploy.

---

## The endpoint

```
GET /api/search-feed?since=<ISO8601>&cursor=<cursor>&limit=<1..200>
```

All parameters optional. No authentication: it returns published content only,
which is already public.

### Response

```json
{
  "items": [
    {
      "id": "9214",
      "title": "What is Teshuvah?",
      "url": "https://jubileeverse.com/article/what-is-teshuvah",
      "content": "Full article body. Markdown or plain text.",
      "summary": "Understanding the meaning of Teshuvah.",
      "language": "en",
      "category": "Teshuvah & Restoration",
      "tags": ["teshuvah-restoration"],
      "author": "Imani Inspire",
      "published_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-04T09:12:00.000Z",
      "related_slugs": [],
      "related_characters": []
    }
  ],
  "next_cursor": "2026-01-04T09:12:00.000Z|9214",
  "count": 1
}
```

**Required:** `id`, `title`, `url`, `content`. An item missing any of them is
counted as `invalid` and skipped — the rest of the page still imports.

**`id`** is the publisher's stable identifier. It is stored as
`pages.source_path = "feed:<id>"`, which is how a full sync works out what has
been withdrawn.

**`content`** may be Markdown or plain text. The chunker splits on headings, so
Markdown keeps its structure; plain prose chunks by paragraph. If the body does
not open with an `#` heading, the title is prepended as one, because each
chunk's breadcrumb comes from the heading path.

**No image field.** P10 is text only, at every tier. A feed may send one; the
index does not keep it and no result card can render it.

---

## Paging

Keyset, on `(updated_at, id)` — never `OFFSET`. An article edited mid-walk
shifts an offset window and silently drops or repeats rows, which on an
incremental importer means missing content nobody notices.

Follow `next_cursor` until it is `null`.

---

## Incremental sync

```
first run     no `since`            → everything
later runs    since=<high water>    → only what changed
```

The importer records the newest `updated_at` it successfully imported in
`ingest_runs.high_water_mark` and sends it as `since` next time. A **failed run
does not advance it**, so records that run missed are asked for again.

Two independent checks decide whether work happens:

| | purpose |
| --- | --- |
| `updated_at` | decides which records are **fetched** |
| content hash | decides whether a fetched record is **re-chunked and re-embedded** |

The hash covers title, content, summary, category, author, language, tags,
characters and related slugs — deliberately **not** `updated_at`. A publisher
that touches that column on every save would otherwise force a re-embed of text
that did not change, which is the expensive half of ingest.

---

## What the importer does with a record

```
feed item → validate → content hash
                         ↓ unchanged → skip (no chunking, no embedding)
                         ↓ changed
                       page row upserted
                         ↓
                       old chunks DELETED, new chunks written
                         ↓
                       embedded_at NULL → the embedding queue, at priority 1
```

Old chunks are deleted rather than added to, so **no stale embedding can survive
an edit**. Verified: editing a record's body leaves the chunk count unchanged
and zero chunks from the previous body.

Priority 1 is §12.2's publish-push lane — a feed import *is* a publish.

---

## Running it

```bash
# one-time: point the domain at its feed
npm run admin -- domains set jubileeverse.com \
    --ingest-mode=feed --source-root=https://jubileeverse.com/api/search-feed

npm run import:feed -- --domain=jubileeverse.com --dry-run   # read, write nothing
npm run import:feed -- --domain=jubileeverse.com             # incremental
npm run import:feed -- --domain=jubileeverse.com --full      # ignore the high-water mark
npm run embed                                                # work off the queue
```

`--full` also handles **withdrawals**: any page whose `feed:<id>` was not seen
during a full walk is marked `gone`. Incremental runs never do this — a record
absent from an incremental page is simply one that has not changed, and treating
that as withdrawn would empty the index on the first quiet sync.

The domain must be `active`. §8.2 reserves Zone A for verified T1, and importing
a feed into an unverified domain would route unverified content there.

---

## Publisher side

Reference implementation: `w:/jubileeverse.com/server/routes/search-feed.js`.

Mount it:

```js
const searchFeed = require('./routes/search-feed');
app.use(searchFeed(pgPool));
```

It selects `status = 'published'` with a non-empty body, from `articles` joined
to `categories`. It is read-only and excludes drafts at the query rather than
downstream, so an unpublished article cannot reach the index even if the
importer has a bug.

### Two fields the reference implementation returns empty

`related_slugs` and `related_characters` drive "Continue this thread" (max 3
links). JubileeVerse has no relations table today, so both are `[]` and the
thread block does not render. Populating them is a publisher-side change; the
importer, the schema columns and the rendering are already in place and were
verified against the ingest path.
