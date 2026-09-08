# Superseded — the SearXNG metasearch path (2026-08-30)

The v0 engine answered "the wider web" half of search by proxying
[SearXNG](https://docs.searxng.org/), the open-source metasearch engine, with
strict SafeSearch forced in its settings. `searxng/settings.yml` and
`searxng-up.sh` are that work, kept here and wired to nothing.

## Why it is not in the v1.1 design

The specification builds Zone B out of a whitelist tier (T2) and a discovery
crawler (T3), and every page in either has to pass the safety pipeline in
§11 before it can be stored, let alone served. `servable_pages` enforces that
structurally: a T3 page with any `safety_verdict` other than `safe` cannot be
returned, and acceptance criterion 21 is proved by querying that view directly.

Metasearch results have no page row, no `safety_verdict`, and no `page_id`. They
therefore could not be:

* gated by `servable_pages` — they would arrive already past it, which is the
  one thing principle **P1**, default deny, exists to prevent;
* logged as impressions, because `result_impressions.page_id` references
  `pages` — so the click loop (R7) would be blind to exactly the half of the
  results it most needs to learn about;
* reported, demoted, or purged — §11.3 and **P5** both assume a row to act on;
* deduplicated against the index, or ranked by the Zone B signal set in §13.6.

Forcing upstream SafeSearch is a real control and a good one, but it is one
engine's opinion applied at fetch time. It is not the five-gate pipeline, and
"strict SafeSearch was on" is not an answer to acceptance criterion 20, which
requires a 100% rejection rate on a test set Jubilee holds.

## Where it could still earn its place

Not as a results source. Possibly as a **discovery input** for T3 candidates,
alongside the trust-graph expansion in §10.2 and the Common Crawl mining
§10.1 mentions as an optional supplement: run a query, take the hosts, and feed
them to the candidate pipeline, where they wait behind the same gates as any
other candidate and are crawled by JubileeSearchBot rather than read from
someone else's index.

That is a late-phase idea and it is not built. If it is picked up, the rule that
makes it safe is the one that made it unsafe as a results source: nothing
reaches a reader without a `pages` row and a verdict.

The container config is left intact so it can be brought back up for that
experiment without reconstructing it. `bin/searxng-up.sh` notes that Docker
Desktop cannot bind-mount `W:`, which is why the config is `docker cp`'d in.
