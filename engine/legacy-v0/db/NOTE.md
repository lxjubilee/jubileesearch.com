# Superseded — v0 schema (2026-08-30)

These three files are the pre-specification schema. They are kept only so the
`inspirecortex-postgres` database that was seeded from them can be read and
migrated; **nothing new should be written against them.**

The specification (`setup/initial_setup.md`, v1.1, 3 Sep 2026) makes the DDL in
its Section 7 the *normative contract* and states that column names are binding.
The v0 schema does not match it, in ways that are not cosmetic:

| v0 | v1.1 spec | Why it had to change |
|---|---|---|
| `domains.kind` / `trust` / `safety_rating` | `domains.tier` (`T0`–`T3`), `status`, `ingest_mode` | Tier drives zone placement (P2, §4). A three-value `kind` cannot express T0 quarantine. |
| `domains.recrawl_hours` | `crawl_interval_hours` | Binding name. |
| `pages` — no `tier`, no frontmatter columns | `tier`, `category`, `office`, `persona`, `characters`, `related_slugs`, `tags` | Source-markdown ingest (R5, §9.1) exists to keep this structure. |
| **`media` table** | *removed* | Principle **P10** and §11.2: image fetching, storage, thumbnails and NSFW screening "are **not built and must not be built**". |
| no `chunks` | `chunks` with `halfvec(1024)` | Semantic retrieval (§7.3, §12). |
| no lexicon / best-bets / signal tables | §7.5–7.7 | R2, R4, R7, R8. |
| `queries` | `search_queries` + `result_impressions` | Impression logging is per-result-per-zone (R7). |

The v0 safety seed's *reasoning* survives and was carried into
`../migrations/024_seed_blocklist.sql` — in particular the scripture problem:
no term rule may target a word that appears in scripture, because a filter that
blocks those words makes a faith-based engine useless at exactly the passages
people search for. That comment is reproduced there, where the next person to
add a term rule will read it.

To migrate an existing v0 database, drop it and re-run `../migrate.mjs`. The v0
index holds crawl output only; there is no editorial content in it to preserve.
