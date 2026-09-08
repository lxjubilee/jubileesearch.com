# JubileeSearch.com

Jubilee's own search engine: a static front end, and the index and API behind it.
Live at https://www.jubileesearch.com (Cloudflare → nginx/1.24.0 Ubuntu).

Built to `setup/initial_setup.md` v1.1 (3 September 2026), which is the
specification and the arbiter of anything this README disagrees with.

```
web/                                   the public front end — Next.js 16, port 3038
engine/                                the index, ingest services and API — port 4038
setup/initial_setup.md                 the specification

index.html  search.html  bot.html      the previous static site, still deployed
css/  js/  fonts/  images/             its assets
deploy.sh                              ships that static site
```

Two READMEs to read next. `engine/README.md` covers what is built, what is not,
the decisions still needed from Gabriel, and every place the implementation
departs from the specification and why. `web/README.md` covers the front end.

**Next.js answers decision D2** — "web front-end stack for the public search
page", which the specification leaves open as a team-skills call. §6.1 fixes
what that front end is allowed to do: *"Presentation only. Zero business
logic."* So the engine keeps every retrieval, ranking and safety decision, and
`web/` renders the answer.

The static site has **not** been deleted. It is the recovered mirror of what is
live today and remains the deployed site until someone decides to cut over;
`web/README.md` sets out what cutting over involves.

---

## State of the build

Phases 1 through 6 of the specification's delivery plan are built: the schema,
source-markdown ingest, the publish webhook, the crawler, the safety pipeline,
the two-zone query pipeline, ranking, caching, the click loop, and the admin API.

Not built: trust-graph discovery (§10.2), so T3 only ever contains hosts someone
registered by hand; the admin console UI, though its API is complete; the
embeddable widget; and the JubileePedia entity sync. `engine/README.md` has the
full list and the reasoning.

Two specification decisions are blocking and are not the developer's to make:
**D5** (where the T1 source markdown lives) and **D9** (seed lexicon authorship).
D5 is the more urgent of the two — until it is answered, no T1 domain has a
`source_root`, so the crawl fallback in §9.1 is the only route into the index.

## Running it on localhost

No Postgres install needed — the engine can run against PGlite, which is
Postgres compiled to WASM, with real pgvector.

```bash
# terminal 1 — the engine
cd engine
npm install
export USE_PGLITE=1 PGLITE_DIR=.pglite-dev NODE_ENV=development ALLOW_INSECURE_ADMIN=true
npm run migrate && npm run dev:seed
npm start          # API -> http://localhost:4038

# terminal 2 — the front end
cd web
npm install
npm run dev        # site -> http://localhost:3038
```

Then <http://localhost:3038/search?q=holy+spirit>.

`engine/npm run site` still serves the old static site on :8080 against the same
engine, which is useful for comparing the two side by side. `engine/npm run
drive -- <url> --eval='...'` drives either of them in a real headless browser,
so you can assert against the rendered DOM rather than read a screenshot.

The full setup, and the list of what PGlite does *not* prove, is in
`engine/README.md`. Short version: the schema and the query pipeline genuinely
execute and are covered on every `npm test`, but concurrency, index selection at
scale, and everything operational still need a real server before release.

---

## The front end

`search.html` renders two zones, and the ordering is a guarantee rather than a
layout preference. **Zone A, "From Jubilee",** is always first; **Zone B, "From
the wider web",** is always beneath it and always labelled as not
Jubilee-endorsed. Acceptance criterion 12 requires that at every viewport in
every client, so `css/styles.css` carries no rule that could reorder them and a
note saying not to add one.

When the network has no good answer, Zone A says so and gives the space to
Zone B rather than padding itself with five weak matches. That empty state is the
discipline the whole zone mechanism depends on, and every occurrence is logged as
a content gap for the writing team.

**No result card contains an image, at any tier.** That is principle P10 and
acceptance criterion 15. The per-result favicons the previous version fetched are
gone: they were images in a result card, and they announced the reader to every
domain in the result list. A letter on a disc does the same job and tells nobody.

Also on each result: a report link (§11.3), and for Jubilee pages up to three
"continue this thread" links built from the frontmatter the writers already
wrote (R10).

### Changes to the recovered site

The files here were mirrored from the live site on 2026-08-29 and redesigned to
match the JubileeInspire AI Bible Chat. Since then:

| Change | Why |
|---|---|
| `js/app.js` now calls `/api/v1/search` | The old `/api/search/web` returned one blended list, which cannot express the Zone A / Zone B guarantee. There is deliberately no compatibility shim. |
| Result favicons removed | Acceptance criterion 15. |
| Form action `/search` → `/search.html` | `/search` currently 404s on the live server. The clean URL wants an nginx rewrite; see below. |
| `bot.html` added | §9.4 requires the bot information page to exist *before* the first external crawl. It still carries the D7 placeholder for the contact address. |

### nginx

```nginx
location = /bot    { try_files /bot.html =404; }
location = /search { try_files /search.html =404; }
```

The first is required: the crawler's user agent string is fixed by the
specification as `JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)`, and
that URL has to resolve. The second restores the clean results URL.

---

## Deployment

`deploy.sh` rsyncs the static site to production and takes a server-side snapshot
first. It ships `index.html`, `search.html`, `bot.html`, `css/`, `js/`, `fonts/`
and `images/`, and does not touch `engine/`.

**The production host and web root are not in this repo.** `deploy.sh` reads
them from `deploy.env` beside it (gitignored) or from the environment:
`REMOTE=root@your.host REMOTE_DIR=/var/www/.../www bash deploy.sh`. It also
needs `~/.ssh/id_ed25519_jubilee_prod`. See the script's header for what the
web root must point at, and what it must not.

The engine deploys separately. `ops/config/websites-services.json` registers
JubileeSearch as a Node app on port 3038, and
`ops/config/cloudflare-config.yml` maps `api.jubileesearch.com` to port 4038,
which is the port the API listens on.

### The missing `server.cjs`

The original backend that served `/search` and `/api/search/*` was never
recovered. It exists only at `/var/www/apps/JubileeSearch.com/` on the server,
and no copy was found on `W:\` or in the flash-drive backups. It is no longer
needed: `engine/` replaces it, against a specification the old one predates.
Anyone with SSH to that host should still pull it before it is overwritten, if
only to see what the old `/api/search/*` contract actually did.
