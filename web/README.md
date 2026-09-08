# JubileeSearch web

The public front end: Next.js 16 (App Router) and React 19, on port 3038.

This answers **decision D2** in `setup/initial_setup.md` — "web front-end stack
for the public search page", which the specification leaves open as "a
team-skills decision".

---

## What this is, and firmly is not

§6.1 defines the job in six words: **"Presentation only. Zero business logic."**

Nothing in this app scores, ranks, filters, expands a query, decides how many
results a zone shows, or judges whether a page is safe to serve. The engine has
already made every one of those decisions by the time a response arrives here.
If you find yourself about to sort an array of results, stop: the order they
arrive in is the answer, and reordering it silently breaks the guarantees the
engine spent §13 establishing.

The one thing this app does own is *how the answer looks*, and the guarantees
that live in the markup:

| Guarantee | Where it is enforced |
|---|---|
| Zone A above Zone B, any client, any viewport (acceptance 12) | `app/(site)/search/page.tsx` renders them in that order, server-side. No CSS in this app can reorder them. |
| No image in a result card, any tier (acceptance 15, P10) | `components/ResultCard.tsx` has no `<img>`. The static site's per-result favicon is gone. |
| Zone B always labelled (acceptance 14) | `components/ZoneBCollapse.tsx` |
| Snippets are extracted text, never markup | `components/Snippet.tsx` |

---

## Running it

The engine has to be running first — this app is a client of it.

```bash
# terminal 1: the engine (see ../engine/README.md)
cd engine
export USE_PGLITE=1 PGLITE_DIR=.pglite-dev NODE_ENV=development ALLOW_INSECURE_ADMIN=true
npm run migrate && npm run dev:seed && npm start     # :4038

# terminal 2: this app
cd web
npm install
npm run dev                                          # :3038
```

Then <http://localhost:3038>.

| Variable | Default | What it is |
|---|---|---|
| `ENGINE_API_URL` | `http://127.0.0.1:4038` | Where the engine answers. In production, `api.jubileesearch.com`. |
| `ENGINE_TIMEOUT_MS` | `5000` | §13.10 budgets 460 ms on a cache miss; this is the point past which something is wrong rather than slow. |
| `SITE_URL` | `https://www.jubileesearch.com` | Canonical origin, for `metadataBase`. |
| `BOT_CONTACT_EMAIL` | *(unset)* | Decision **D7**. Until it is set, `/bot` says so instead of showing a fake address. |

Port 3038 is not arbitrary: `ops/config/websites-services.json` already
registers `jubileesearch` as a Node app on it, and
`ops/config/cloudflare-config.yml` maps `www` → `:3038` and
`api.jubileesearch.com` → `:4038`. This app slots into the deployment that
already exists.

---

## How it is put together

```
app/
  (site)/            root layout with the JubileeInspire rail
    page.tsx         home
    search/page.tsx  results — server component, fetches the engine
    not-found.tsx
  (bare)/            second root layout, no rail
    bot/page.tsx     the crawler information page (§9.4)
  globals.css        ported from css/styles.css, byte for byte
  inspire-rail.css   ported from css/inspire-rail.css, byte for byte
components/          the rail, the search box, zones, cards, panels
lib/
  types.ts           the Search API contract, typed
  api.ts             server-side engine client
```

**Two root layouts.** `(site)` and `(bare)` each render their own `<html>` and
`<body>`. The difference is the rail: `bot.html` deliberately had none, because
whoever lands there followed a user-agent string out of an access log and wants
to know what the crawler is, not to browse a ministry network. Nesting cannot
remove a parent layout's chrome, so the split is the mechanism.

**Server components by default.** The results page fetches from the engine on
the server and renders the zones into the HTML. That is the substantive gain
over the static site — no loading flash, no layout shift when results land, and
acceptance criterion 12 holds before any JavaScript runs. Only four components
are client components, and each earns it: the rail (localStorage), the search
box (typeahead), the Zone B toggle (sessionStorage), and result telemetry (click
logging).

**Result telemetry is one delegated listener**, not a handler per card, so
`ResultCard` stays a server component and the JavaScript this page ships does
not grow with the number of results.

---

## Ported CSS stays global; new CSS goes in modules

`globals.css` and `inspire-rail.css` are the static site's stylesheets,
unmodified — `diff` them against `../css/` and they match exactly. That CSS *is*
the design: its vertical rhythm was matched box for box against JubileeInspire's
chat welcome state, and re-expressing it as modules would risk drift the reader
can see, for a tidiness nobody can.

So the convention is: **anything inherited is in the two global files, anything
this port added is in a `.module.css` next to its component.** A diff against
the static site therefore stays meaningful.

---

## Changes from the static site

Three, and none of them is a silent tidy-up.

**The suggestion dropdown now exists.** `js/app.js` had the fetching, the
keyboard navigation and the rendering — and neither `index.html` nor
`search.html` contained a `#suggestions` element, so `renderSuggestions()` bailed
on every keystroke and the feature had never run. The engine's `/api/v1/suggest`
works and always has. `components/SearchBox.tsx` wires it up, with out-of-order
response handling that the original lacked.

**The scope chips are links, not buttons.** The scope lives in the URL, so it is
shareable, survives a reload, works with JavaScript off, and is applied by the
engine — Zone B is not sent at all rather than sent and hidden.

**The footer no longer asks for your location on arrival.** This one is a
behaviour change and is flagged at length in `components/LocationRow.tsx`. The
static site called `getCurrentPosition()` on load and sent the coordinates to
OpenStreetMap's Nominatim to render one line of text that nothing else used. No
requirement asks for it, §17 Privacy is pointed about what leaves the system,
and Nominatim's usage policy does not permit being a page's automatic per-load
geocoder. The row is still there; it waits to be clicked. **If the network wants
the old behaviour, that is a decision to make, and it is one file to change.**

---

## What is not built here

* **`/suggest`** — Zone A's empty state links to it as the content-gap capture
  form (§13.5, §16). The link exists; the page does not.
* **The admin console** (§15). Its API is complete in the engine; there are no
  screens. It is a bigger app than this one and probably wants its own route
  group with SSO in front of it.
* **The embeddable widget** (§14).
* **`debug=true`** rendering. The engine returns the full scoring breakdown and
  `lib/types.ts` types it, but nothing displays it. P4 is satisfied at the API;
  a reviewer currently reads JSON.

---

## The static site is still there

`../index.html`, `../search.html` and `../bot.html` have not been deleted, and
`deploy.sh` still ships them. They are the recovered mirror of what is live
today, and they remain the deployed site until someone decides to cut over.

Cutting over means: build this app, run it on 3038 under the process manager
`ops/config/websites-services.json` already describes, and point nginx at it
instead of the static root. At that point the root HTML files become history
rather than the site, and `deploy.sh` needs rewriting for a Node app — it
currently rsyncs static files.

That decision is not this port's to make, which is why both still exist.
