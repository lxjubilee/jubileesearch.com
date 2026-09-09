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

# terminal 3, optional: a stand-in Jubilee ID so sign-in can be exercised
cd web && npm run dev:sso                            # :4031
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

## Sign-in — the Jubilee ID door

The email-first door every Jubilee property shares, ported from **kJubilee.com**
and following `docs/JUBILEE-ID-DOOR-STANDARD.md` in that repository —
specifically its closing section, "Applying this to a third site". JubileeSearch
is that third site.

A reader never leaves the site. The door asks for an email, looks it up at the
authority, and routes to one of two outcomes:

| | | |
| --- | --- | --- |
| **A** | the email has a Jubilee ID | password → signed in |
| **C** | it has none | create the Jubilee ID, signed in |

kJubilee has a third outcome, **B**: a Jubilee ID that is new to *that site*,
which confirms the password and then shows a visible Create Account screen.
JubileeSearch has no account of its own to create — §14 forbids it a user table
and §17 says signing in changes exactly one thing about what is recorded — so
that screen is absent. Adding it would ask for consent to something that does
not happen.

### What the standard fixes, and what it forbids copying

The standard is the ladder, the sizes and the spacing below the wordmark. It
says in as many words that **colour and the wordmark are never shared**: "the
accent IS the site". So this door takes JubileeSearch's own:

| | kJubilee | here |
| --- | --- | --- |
| heading face | Orbitron (its wordmark's) | **Agency FB** (ours) |
| heading | uppercase, `calc(1.55rem * .75 * .9 * .9)` → 15.07px | same chain → **15.066px** |
| branding circle | 92px → 69px | 92px → **69px** (§4) |
| accent | `#3DA5FF` | `#3DA5FF` — identical, but by inheritance: `globals.css` already records it as "kjubilee.com's --accent" |

The size chain is written as the chain rather than the answer, so the three
reductions the standard describes stay legible in the CSS.

### The protocol

```
app/(auth)/layout.tsx            a fourth root layout — the door is full-viewport
app/(auth)/{signin,login,signup} one door behind three URLs, as kJubilee does
components/auth/JubileeIdDoor    the email-first flow
components/auth/AuthShell        the two-panel frame
app/(auth)/jubilee-id.css        the whole look
lib/sso.ts                       the service-token client (ported from kJubilee's lib/sso.js)
lib/sso-door.ts                  what more than one route needs
app/api/sso/**                   lookup · login · register
lib/session.ts                   the AES-256-GCM sealed, httpOnly cookie
```

The server mints a **service token** from `SSO_CLIENT_ID` + `SSO_CLIENT_SECRET`,
then calls the authority on the reader's behalf — `/api/auth/lookup`,
`/api/auth/login`, `/api/auth/register`, `/api/auth/session/open`. Identical to
kJubilee's client, so the two sites speak one protocol to one authority.

**§14 is not weakened by any of this.** The password is typed here and verified
*at the authority*; this application stores no password, has no user table, and
has nothing to reset.

### The one deliberate divergence: where the token is kept

kJubilee's `respondSignedIn` returns the token to the browser and `storeAuth`
writes it to `localStorage`, because its radio player and rail read it there.
**This port seals it in the httpOnly cookie instead**, for two reasons that are
specific to search:

* The engine verifies every bearer token against the authority's JWKS and reads
  `search_admin` out of the claims. It has to be the *authority's* token — a
  locally minted one would be refused, and the admin console with it.
* §14 gates that console on the right. A token the browser can read is a token
  an XSS on any Jubilee property can lift and replay against `/api/v1/admin/*`.

Verified: `document.cookie` cannot see the session, and the console still renders
with `search_admin`. kJubilee keeps its *family* session in an httpOnly cookie
for the same reason, so this is the family's own practice rather than a
departure from it.

### One more divergence, in the backdrop

kJubilee cross-fades four photographs from `images.unsplash.com`. Loading them
would hand Unsplash the IP address of every reader who opens this page, and
`/privacy` enumerates exactly who sees anything — it would have made that notice
incomplete the day it shipped. The slides are gradients: same cross-fade, same
overlay, bubbles and scripture, sourced from nobody. Put real photographs in
`public/images/auth/` and swap `BACKDROPS` in `AuthShell.tsx` to change that.

Turnstile is likewise absent: kJubilee gates Screen 1 with it, and its own door
renders nothing when no site key is set. There is no key here, so there is no
widget and no third party.

### What signing in costs, kept on the screen

§17: "Query logs retain `jubilee_id` only where the user is signed in." The page
this door replaced listed that cost beside the two benefits, and matching
kJubilee exactly would have quietly dropped it. It is still there, in
`.door-ledger`, on the one screen where it is the decision being made.

### Trying it without the real Jubilee ID

`npm run dev:sso` starts a stand-in authority on `:4031` — the service API the
door calls, plus **the JWKS the engine verifies against**. Those have to be one
service: the thing that mints access tokens and the thing that publishes the
verification key cannot disagree. Signatures are real RS256, so the engine's
verification path is genuinely exercised.

**It authenticates nobody**: three identities are seeded in memory and the
password is `jubilee123`. It refuses to start unless `NODE_ENV` is unset or
`development`.

| | right |
| --- | --- |
| `zev@jubileesearch.com` | `search_admin` |
| `viewer@jubileesearch.com` | `search_viewer` |
| `reader@jubileesearch.com` | none |

```bash
npm run dev:sso                       # terminal 3, :4031

# web/.env.local
SSO_BASE=http://127.0.0.1:4031
SSO_CLIENT_ID=jubileesearch
SSO_CLIENT_SECRET=development-only-not-a-real-secret
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")

# engine/.env
SSO_JWKS_URL=http://127.0.0.1:4031/jwks.json
SSO_ISSUER_URL=http://127.0.0.1:4031
```

`SESSION_SECRET` is required and has no default: a predictable key on a cookie
carrying an access token is the same as no encryption, and a development
fallback is exactly the sort of thing that ships because it worked locally. With
nothing configured the door names the missing variables rather than answering
"try again in a moment", which would not be true.

---

## Admin console

`/admin`, the ten screens §15 lists, in the order §15 lists them — so the
sidebar can be read straight down against the specification.

```
app/(admin)/layout.tsx          a third root layout, beside (site) and (bare)
app/(admin)/admin/layout.tsx    the shell and the access gate
app/(admin)/admin/*/page.tsx    one directory per screen
lib/admin.ts                    typed client; attaches the bearer token
lib/admin-actions.ts            every write, each re-checking authorization
components/admin/               nav, shared furniture, form plumbing
```

Its own root layout and its own stylesheet. The console shares nothing with the
search UI: `globals.css` is the ported search design and is kept byte-identical
to the static site, while this is a working surface that wants dense tables and
semantic colour. One stylesheet for both would drag search's rhythm into an
operator tool.

### Two independent gates, neither trusting the other

The layout decides what to **render**. It is not the security boundary:

1. **The engine** requires a bearer token carrying `search_admin` or
   `search_viewer` on every admin route, and refuses without one.
2. **Every server action** calls `requireSession('admin')` before it writes.

The second exists because of a warning in the Next docs worth quoting: a Server
Action is *"reachable via direct POST requests, not just through your
application's UI"*. A button that is never rendered is not a control. Hiding the
write buttons from a `search_viewer` is a courtesy — the engine would refuse
them anyway.

The access token never reaches the browser. It lives in the httpOnly session
cookie, is read on the server, and is attached to the engine call.

### Rules the screens follow

**Counts are shown exactly as the engine returned them.** Acceptance criterion 27
is "Admin console counts match direct database counts", so the dashboard does no
arithmetic of its own beyond formatting two rates. If a number looks wrong, the
SQL is wrong — there is no second calculation to check.

**Crawled page text is never rendered as markup.** §17 Security requires it, and
the safety queue is the screen that displays content nobody has cleared yet. The
excerpt goes through React's escaping into a monospace block. There is no
`dangerouslySetInnerHTML` in the console and none belongs here.

**"Could not load" is never drawn as "nothing here".** An operator acting on an
empty table that is really a failed request is the failure mode worth designing
against, so `LoadFailed` says outright that the console does not know the answer.

**A destructive action names its blast radius.** "Block jubileeverse.com" says
that *every* page of the domain is purged, not just the one under review; T2
approval and a T3 probe get different button text because they are different
decisions (§11.4 versus §10.2).

### What is not built

Each of these needs an endpoint the admin API does not have, and the screen says
so in place rather than showing a control that cannot work:

* **Domains** — bulk import, editing a registration in place, pause, forced reingest.
* **Lexicon** — bulk import, and the live preview of how a sample query expands.
  A preview needs expansion without a search; faking it client-side would preview
  something other than what the engine does.
* **Best bets** — drag-to-reorder and scheduling windows (the columns exist; there
  is no update endpoint, so a change means deactivate and recreate).
* **Analytics** — total query volume by intent, click-through by *position*, and
  lexicon concept hit rates. The zero-result sample cannot stand in for these: it
  describes a different population.
* **Index tools** — per-page reindex, per-page purge, re-embed.

---

## The content-request page

`/suggest` is where Zone A's empty state leads. That link shipped pointing at a
page that did not exist, so the one invitation the engine extends to a reader --
"Tell us what you were looking for" -- ended in a 404.

The empty state now carries the query and the detected language on the link, so
the page can quote the failed search back and file the request against something
concrete rather than asking the reader to retype it.

It is a real `<form method="POST">` to a route handler, not a fetch from a click
handler, so it works with JavaScript disabled and before hydration -- the same
reasoning as the search box. The handler replies with a 303, which is also what
stops a refresh from re-submitting.

**The request is stored with no identifier at all** -- no Jubilee ID, no session,
no IP (`017_content_requests.sql`). §17 forbids cross-site behavioural profiles,
and a table pairing a person with what they hoped to read would be exactly that,
and more revealing than the search log beside it. The consequence is stated on
the page rather than hidden: we cannot reply. A test asserts the table's column
list, so adding an identifying column later fails the suite instead of quietly
making the privacy notice false.

---

## Privacy notice and terms

`/privacy` is a specification requirement: §17 Legal says to publish "a bot
information page and a **search privacy notice**". `/terms` is not required by
the specification and is grounded in what the specification does commit the
service to rather than in boilerplate.

Both replaced the footer links that pointed at jubileeenterprise.com. The
network-wide pages cannot describe what *search* records, which is the thing
§17 asks to be published.

**Every factual claim on the privacy page is one the code keeps.** That is the
rule these pages are written under, and it had one immediate consequence: §17
promises query logs are "purged or anonymized after 13 months" and nothing did
that. Writing it down would have made the notice false, so
`engine/src/jobs/retention.js` was built first. It strips `jubilee_id` and the
session identifier from anything past the window, keeps the row so aggregate
click learning survives (§17 permits either, and permits that learning in the
same sentence), drops old reporter IPs, and records each pass in
`retention_runs` so the claim is auditable. `audit()` answers the question the
notice raises: *is what we tell readers still true?*

### What the pages will not say

The entity, the governing law, the venue, the contact address and the effective
date are configuration (`lib/legal.ts`), and both pages show a visible banner
naming what is still blank. A plausible company name and jurisdiction in a
privacy notice is a false statement to every reader and regulator who relies on
it, so they are left empty rather than invented. Setting `LEGAL_ENTITY`,
`LEGAL_CONTACT_EMAIL`, `LEGAL_JURISDICTION` and `LEGAL_EFFECTIVE_DATE` fills
them in and removes the banner.

Neither page has been reviewed by a lawyer, and the terms deliberately carry no
liability, indemnity or dispute-resolution clause — those are legal decisions,
not descriptions of software.

### One finding worth acting on

Clause 6 of the privacy notice discloses that **Google Fonts receives every
reader's IP address on every page load**, because `app/(site)/layout.tsx` links
Open Sans and Oswald from `fonts.googleapis.com`. It is the only third party
that sees anything without the reader choosing it, and it sits badly beside the
rest of the page.

It is disclosed rather than fixed because fixing it means self-hosting those two
faces, and the ported `globals.css` refers to them by family name — so the fix
touches the one file this port keeps byte-identical to the static site. That is
a small, contained piece of work and it is worth doing; it was not done silently
inside a task about writing two pages.

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
