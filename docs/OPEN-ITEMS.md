# Open items

Known gaps as of the first real JubileeVerse CDN index (600 articles, 5,644
chunks, all embedded). Every one of them was found by verification or by a
purpose-built audit, never by a failing test — which is the common thread and the
reason they are written down here rather than left to be rediscovered.

Items 1 and 2 are the ones a test could not have caught even in principle: a
query against a misspelled bridge still returns results, and a lexicon that is
short on concepts still answers. Both now have a runnable audit
(`npm run eval:lexicon`, `npm run eval:candidates`) so they stay measured.

Ordered by what they cost.

---

## 0. No Jubilee Inference API exists — models run locally

**Status 2026-09-14: RESOLVED for embeddings, reranking and safety.** The
Inference API (`engine/InferenceAPI`) now runs on the RTX PRO 6000 workstation
(DirectML adapter 0, fp16) and production reaches it over a reverse SSH tunnel
on its own loopback (`127.0.0.1:4033`), authenticated by `INFERENCE_API_KEY`.
Roles served: `bge-m3@onnx-fp16` (embed), `bge-reranker-base@onnx-fp16`
(cross-encoder), `toxic-bert + nli-deberta-v3-base` (family safety, see
`InferenceAPI/src/safety.js`). Measured on the GPU: 4.8 ms per chunk in batch,
8 ms per warm query, 14 ms to rerank 20 pairs. The corpus (5,561 chunks) was
re-embedded in 313 s. Still a deviation from §16 in one respect: the service
runs on a workstation, not a hosted inference tier, and it is reachable only
while that workstation is logged on (`InferenceAPI/ops/README.md`).

**This is a deviation from the specification, not a dev shortcut that disappears
on deploy.**

No Jubilee Inference API URL or credential exists in any repository on this
machine (~60 checked). `inference.jubileeinspire.com` and
`inference.jubileeenterprise.com` do not resolve. `INFERENCE_API_URL` is set in
no `.env` anywhere.

§16 makes that API "the sole provider of embeddings, reranking, and safety
classification" and states that **JubileeSearch runs no models of its own**. This
build runs ONNX models locally, in a separate process
(`engine/bin/dev-inference.mjs`) that speaks the same HTTP contract — so `src/`
still contains no model, but the network boundary the spec relies on is not
there.

**Blocks Phase 6 outright.** Safety Gate 3 classification has nowhere to run:
`dev-inference.mjs` returns 503 for `/v1/classify/family-safety` on purpose,
because a keyword list posing as a family-safety classifier would admit unsafe
pages into Zone B while looking like a control. With no classifier, P1
default-deny holds and every crawled page stays in T0 — which is why Zone B is
empty and cannot be filled.

**Decision D8 is unanswered** (whether the RTX PRO 6000 is cleared to take
ingest-time embedding batches alongside persona traffic).

### What to replace, for whoever wires the real API

| role | model | source | size | load | throughput |
| --- | --- | --- | --- | --- | --- |
| embeddings | `Xenova/bge-m3` (`dtype: int8`) | HuggingFace ONNX | 542 MB | ~20 s cold | **~3.2 s/chunk**, CPU (see below) |
| rerank | *none* — a bi-encoder cosine stand-in | — | — | — | not the specified cross-encoder |
| safety | *none* — returns 503 | — | — | — | — |

`bge-m3` is natively **1024-dimensional**, matching `chunks.embedding
halfvec(1024)` exactly — no padding. Verified on this machine: related pair
0.748, unrelated 0.303.

### Throughput: the batch guidance in §12.2 is unachievable on this stand-in

Measured on this machine, one request at a time, with a realistic 500-word chunk:

| batch | total | per chunk |
| ---: | ---: | ---: |
| 1 | 4.1 s | 4,141 ms |
| 2 | 6.5 s | 3,236 ms |
| 4 | 13.1 s | 3,276 ms |
| 8 | 24.4 s | 3,046 ms |
| 16 | 43.4 s | 2,715 ms |

**A one-word input takes 444 ms; a real chunk takes 2.7–4.1 s.** An earlier
version of this table said ~116 ms/chunk. That figure was measured on a trivial
input and was wrong by more than an order of magnitude — a benchmark on toy data,
which is the performance equivalent of the silent-preflight failure in
`eval/preflight.mjs`.

Consequences, all of which are properties of the CPU stand-in and not of the
design:

* **§12.2's "batches of 32 to 64" cannot be used.** At 2.7 s/chunk a batch of 32
  is ~87 s. That guidance was written for a GPU inference service.
* `TIMEOUTS.embedBatch` was a hardcoded 30 s, which aborts every batch above 8.
  It is now `EMBED_BATCH_TIMEOUT_MS`, and the value must match the provider
  actually in use.
* The full 5,644-chunk corpus takes **~5 hours** at `EMBED_BATCH=8`. §12.2's
  target — the whole 10,000-page T1 corpus inside 4 hours — needs the real card.

### The retry storm, and why an aborted fetch is not a cancelled request

The first attempt at this backfill embedded **0 chunks and recorded 15,348
failures**, all of them `This operation was aborted`. The 30 s cap aborted each
batch of 48; the job retried three times per chunk as §12.2 requires; and because
**an aborted fetch does not cancel the work already handed to the server**, every
retry queued more work onto a single-threaded model. It stopped answering even a
one-word request.

Two things made that hard to see, and both are fixed:

* The job logged **once, at the end**. Over a multi-hour run the only external
  sign of life was database write activity — and that looks identical whether it
  is writing vectors or writing failure counters. It now logs progress each
  minute with a chunk rate and an ETA, and reports the **first** failed batch
  immediately rather than in the summary.
* Nothing distinguished "slow" from "wedged". The check that does is trivial and
  worth remembering: send a one-word input. If that does not come back, the
  problem is not the batch size.

After a failed run every affected chunk sits at `embed_next_attempts = 3` and is
no longer claimable. Resetting is deliberate, not automatic:

```sql
UPDATE chunks SET embed_next_attempts = 0, embed_next_error = NULL
 WHERE embed_next_attempts > 0;
```

The specified reranker `bge-reranker-v2-m3` is **gated on HuggingFace (401)** and
`BAAI/bge-reranker-v2-m3` ships **no ONNX build**, so unlike the embedder it
cannot simply be run locally. Alternatives with ONNX builds exist
(`Xenova/bge-reranker-base`, `mixedbread-ai/mxbai-rerank-xsmall-v1`) and are
evaluated in the cross-encoder plan; none is adopted.

Every chunk records `model_id`, which is what makes replacing any of this a
rolling §12.3 backfill rather than a delete-and-re-embed.

---

## 1. The lexicon does not speak the corpus's spelling

**Status:** one confirmed defect, one measured shortfall. Found by
`npm run eval:lexicon`, which is new and should be run after any corpus import.

### 1a. `mishpachah` vs `Mishpakhah` — confirmed

The corpus writes **Mishpakhah** on 10 pages. The lexicon lists `mishpachah`
(2 pages) and `mishpacha` (0). So:

* a query for **family** expands, matches the concept, and rewrites to
  `mishpacha | mishpachah` — a spelling 10 of the 12 relevant pages do not use
* a query for **mishpakhah**, the corpus's own dominant spelling, matches **no
  concept at all** and does not expand

Both directions of gold pair X11/X12 fail on this, and neither fails visibly:
the query still returns results, just not through the bridge. That is why no
test caught it, and it is exactly the failure R2 exists to prevent.

**Decided: the lexicon carries both spellings. The corpus is not rewritten.**

`category_slug` is `celebration-mishpakhah`, so the corpus spelling is
load-bearing in live URLs; 600 published articles will not be re-spelled; and the
corpus is internally inconsistent anyway (10 pages `Mishpakhah`, 2 pages
`mishpachah`). A lexicon that bridges both spellings is **correct behaviour, not
a workaround** — bridging surface forms is the entire function of R2.

Pending as of this writing: `mishpakhah` and `mishpakha` are added as terms on
the existing `mishpachah` concept. Not yet applied — the lexicon is frozen for
the duration of the model migration, so the two deltas stay attributable (see
item 3).

The inconsistency itself stays here as an **editorial note for JubileeVerse**,
not a search defect: two spellings of the same word across one corpus is a house-
style question for the publisher of record. Search will answer correctly either
way once both are listed.

### 1b. The audit over the whole lexicon

46 concepts, 185 terms, against 600 articles:

| | |
| --- | --- |
| REACHABLE | 37 |
| MISSPELLED-DOMINANT | 7 flagged, **1 real** (`mishpachah`) |
| MISSPELLED | 0 |
| UNCOVERED | 2 — `kingdom`, `yetzer_hara` |

Of the 7 flagged, `brit`→breath, `grace`→chain and `shavuot`→sheaves are
artefacts of the deliberately loose skeleton matcher. `salvation`→`yeshua` and
`talmid`→`talmud` are real words in the corpus but **different concepts**, and
merging them would be wrong. The tool proposes; a person judges. Its output is
not a work list.

**A term with zero corpus occurrences is usually the bridge working.** `holy
spirit` occurs 0 times and `jesus` occurs 0 times because this corpus writes
Ruach HaKodesh and Yeshua. Deleting those entries would remove the bridge's
entire purpose. Judgement is per concept, never per term.

The two UNCOVERED concepts are also not defects: nothing in the corpus discusses
the kingdom of God or the yetzer hara under any spelling. The lexicon is ahead of
the content, which is the right way round.

---

## 2. D9: the seed lexicon is 46 concepts, not 60

**Status:** short by 14. D9 is *"Phase 3, blocking"* and asks for 60 to 100.

Every requirement §13.3 **names** is present:

| | |
| --- | --- |
| divine names | 5/5 — Yahuah, Yeshua, Elohim, Ruach HaKodesh, HaMashiach (+3) |
| core concepts | 7/7 — teshuvah, chesed, shalom, mishpachah, Torah, mitzvot, kadosh (+13) |
| appointed times | all seven of Leviticus 23, plus Shabbat, Hanukkah, Purim |
| Romanian pairs | 36 terms |
| Hindi pairs | 10 terms |

So the gap is a count, not a coverage hole in anything the spec enumerates — and
14 arbitrary concepts added to reach 60 would satisfy the letter and bridge
nothing.

### What the 14 should be, by measurement

`npm run eval:candidates` scans the corpus for capitalised mid-sentence forms
the lexicon cannot reach. One class dominates: **this corpus writes biblical
proper nouns in both registers, usually in different articles.** The lexicon
contains not one of these pairs.

| concept | Hebrew | English | he-only | en-only | pages bridged |
| --- | --- | --- | ---: | ---: | ---: |
| israel | Yisrael, Yisra'el | Israel | 84 | 94 | 178 |
| yeshayahu | Yeshayahu | Isaiah | 5 | 108 | 113 |
| moshe | Moshe, Mosheh | Moses | 87 | 24 | 111 |
| dawid | Dawid | David | 11 | 68 | 79 |
| yerushalayim | Yerushalayim | Jerusalem | 37 | 42 | 79 |
| mitsrayim | Mitsrayim | Egypt | 21 | 55 | 76 |
| yaakov | Ya'akov, Ya'aqov | Jacob | 51 | 15 | 66 |
| shaul | Sha'ul | Paul | 37 | 26 | 63 |
| avraham | Avraham, Avram | Abraham, Abram | 35 | 17 | 52 |
| yirmeyahu | Yirmeyahu | Jeremiah | 3 | 42 | 45 |
| yehudah | Yehudah | Judah | 26 | 12 | 38 |
| aharon | Aharon | Aaron | 30 | 5 | 35 |
| yosef | Yosef | Joseph | 20 | 8 | 28 |
| yehoshua_bin_nun | Yehoshua | Joshua | 11 | 7 | 18 |

"Pages bridged" counts pages carrying **one** register and not the other — pages
a query in the other register cannot reach today. 981 in total, on a 600-page
corpus, because most pages appear under more than one of these names.

**Decided: all fourteen approved, all fourteen symmetric at full weight (1.00).**

### The reduced-weight rule — written down, and switched off

All 14 proper-noun concepts use full weight (1.00) in both directions.
Checked every English surface form against the `characters` frontmatter of all
600 articles: 1,149 distinct names, none biblical. The corpus characters are
deliberately modern and global — Marcus Bell, Priya Raman, Yusuf Adeyemi,
Solveig Aamodt, Akosua Bediako — so no English biblical name collides with a
character name.

**This reflects current editorial practice, not a guarantee.** If JubileeVerse
introduces a character with a biblical name, re-run `npm run eval:contamination`
and apply reduced weight (0.30–0.40) to that term's English → Hebrew direction.
The Hebrew surface forms need no such treatment: nobody is going to be called
Mosheh or Yerushalayim.

**Known exception, not acted on:** `charity` (concept `tzedakah`, w=0.70)
collides with **Charity Faircloth** on one page. One page does not justify
degrading a working bridge.

A rule that is written down, switched off, and states when to switch it on is
more useful than one quietly applied to a single term.

### Why the rule was expected to have members, and does not

The plan had been to reduce the English → Hebrew weight wherever an English
surface form also names a character — a query about a character called Paul
should not pull in the apostle's articles. It has no members. Sampling the body
text agrees with the frontmatter check: every mid-sentence "David", "Paul",
"Aaron", "Joseph" in this corpus is the biblical figure.

That corrects an earlier claim in this file. I had written that the English
column of the table above was an upper bound because of modern characters named
Paul, Aaron, Joseph and David. There are none. The counts stand as measured.

`iyov`/`job` is still excluded, for a different reason: "job" is the English
noun for employment. That is a homograph problem rather than a character one, and
the one the 361 figure was measuring.

Ten runners-up are recorded in `engine/eval/results/lexicon-proposal.json`
(Kefa, Noach, Shemot, Devarim, Eliyahu, Yitzchak, Tsion, Miryam, Yochanan, and
Iyov with its caveat) if the count is ever wanted above 60.

---

## 3. Model migration and lexicon change are sequenced, not combined

**Status:** in progress. The lexicon is **frozen** until the model migration
completes.

§13.3 says expansion applies to the lexical path only, so lexicon changes cannot
touch embeddings — the two are independent. But both move recall, and changed in
one step the delta is unattributable.

| | |
| --- | --- |
| 1 | freeze the lexicon *(done)* |
| 2 | backfill bge-m3 into `embedding_next`, MiniLM still serving *(migration 028)* |
| 3 | evaluate both on the 85 pairs — the delta is the model, cleanly |
| 4 | cut over if it wins, bump the index version |
| 5 | re-derive thresholds from the bge-m3 distribution, via `npm run eval:thresholds` |
| 6 | apply the mishpakhah terms and the 14 concepts, re-measure |
| 7 | the delta from step 6 is the lexicon, cleanly |

Two clean measurements rather than one confounded one. Step 6 is cheap: no
re-embedding, lexical path only.

Migration 028 adds `chunks.embedding_next` with its own partial HNSW indexes and
an `embedding_migration` view. Nothing on the request path reads that column —
`eval/run.mjs --column=next` is the only caller — so the candidate can be
measured while the incumbent serves, and a losing candidate is dropped without
any serving path having seen it.

---

## 4. The Zone A relevance gate is off — cross-encoder needed

**Status 2026-09-14: ON, conservatively.** The gate now runs on the
cross-encoder's own scale (`coverage.js crossEncoderGate`), which is the fix the
text below asks for. `rerank_zone_a = 1`, `zone_a_cross_encoder_floor = -6.5`.
Calibrated on production against the gold set with `bge-reranker-base` scoring
`title + snippet`: false-positive top scores p50 -5.6 (pizza -8.5, quantum
chromodynamics -10.1, cheap flights -7.8), positive top scores p50 -4.0, p10 -7.0.
At -6.5 the six clearest off-topic negatives return the empty state and roughly
8% of positives lose a weak Zone A answer they would otherwise have shown. The
distributions overlap because the reranker sees a snippet, not the chunk, and
because `bge-reranker-base` is not `v2-m3`; both are the next things to change
before tightening the floor.

**Status:** wired and disabled. `zone_a_cross_encoder_floor = -1` (migration 025).
**Cost:** roughly 15 of 35 measured negative queries return a genuine false
positive. `best laptop deals` returns *"Sons Do Not Hand It Back"*.

`zone_a_relevance_floor` is set to `0.0080` and **admits every one of the 35
negatives**. It reads like a tuned threshold and is not one — migration 026
carries the full curve and the objective it was chosen under.

No value of it can work, and the reason is structural rather than a matter of
tuning. The floor applies to the fused score, and the fused score is RRF —
`1/(k + rank)`. It is derived from **rank** and carries no magnitude: a rank-1
result scores identically whether the match is excellent or absurd.

Neither pre-fusion arm can gate either, because **the arms are complementary**:

| | wanted (21 queries) | junk (35) | separating value |
| --- | --- | --- | --- |
| cosine | 0.2716 – 0.6268 | 0.1610 – 0.5183 | none |
| BM25 | 0.0010 – 7.6000 | 0.0007 – 9.4000 | none |

Nine of the 21 wanted queries have **no cosine score at all** on their top result
(found lexically); three have **no BM25 score** (found semantically). A cosine
floor deletes the first nine, a BM25 floor the last three. Gating on one arm
discards exactly what the other arm is for.

**This will not improve with more content.** More articles give the fused score
*more* plausible rank-1 candidates, not fewer, and the corpus genuinely uses the
colliding words — "repair", "restoration", "anchor", "grace".

**Treat as the next milestone.** §6.1 specifies `bge-reranker-v2-m3`, which scores
query and document together and is the one signal in the design with both
magnitude and cross-query comparability. The development stand-in is a
bi-encoder on a different scale, which is why the gate is unset rather than
tuned to it. Wiring it is a one-line predicate in `src/query/coverage.js`.

**Distinguish two things when measuring it.** Of the 35 negatives, ~15 are false
positives (no genuine relation) and ~20 are honest weak matches on words the
corpus really uses — `repair` returning *"Repair Does Not Require a Villain"* is
the engine working. A gate that suppresses the second group is over-tuned, not
correct.

**When you tune it, the value needs a migration — not a console change.**
`/api/v1/admin/ranking` writes to one database. It is audited and revertible, and
it is the right tool for exploring a value, but a threshold set that way exists
nowhere else: a fresh deployment seeds whatever the migrations say. That already
happened once with `zone_a_relevance_floor` (see item 4 of this list's history —
a fresh database seeded 0.0150 while a migration comment asserted 0.0080). Tune
in the console, then write the settled value into a migration.

`npm test` now prints a migrations-vs-database comparison for every `zone_a_*`
key on every run, and fails outright if a migration's prose names a value its SQL
does not set. Divergence itself does not fail — a tuned dev database is
legitimate — it is just made visible.

---

## 5. Language: available, not blocked

**Status changed.** This item previously read "no `language` field exists
anywhere" and treated cross-language recall as blocked upstream. That was true of
the JubileeVerse CDN bundles and is still true of every article's frontmatter —
including the Romanian sites, which carry no `language` key at all. But it is
the wrong place to have looked.

**The language is declared per tenant, not per article.**
`InspireManna.com/tenants/<domain>.json` carries an explicit field:

```json
{ "tenant": "pocaieste.com", "language": "ro-RO", ... }
```

Of 132 tenants, 130 are `en` and **two are `ro-RO`** — `pocaieste.com` and
`pocaintasibotez.com`, 168 articles between them. Their prose is genuinely
Romanian ("Banca a treia, lângă calorifer"), not English with Romanian titles.

That is enough to make acceptance criterion 9 testable, and it needs no upstream
change:

* `domains.language_hint` already exists and is already read by `mapToPage`.
  Setting it from the tenant file is the whole mechanism.
* `detectLanguage()` in `src/text/normalize.js` already supports `ro` (script
  ranges plus a stopword tie-break), so detection can confirm the hint rather
  than depend on it.
* `w_lang` stops being constant across the corpus and starts contributing to
  ordering, which it cannot do today.

The 15 cross-language gold pairs deferred in `eval/gold-set.json` become
authorable as soon as those two sites are indexed. They are still deferred — the
corpus is not indexed yet — but the reason is now sequencing, not a missing field.

Romanian also has direct lexicon consequences. `pocaieste.com`'s tenant file
fixes its divine-name register: **Dumnezeu, Isus, Hristos, Duhul Sfant**, with a
note that the spelling is pinned "so the corpus cannot drift between Isus and
Iisus". The seed lexicon's 36 Romanian terms should be checked against that list
the same way `npm run eval:lexicon` checks the English side.

---

## 6. The negative query set is scoped to a faith-only corpus

**Status:** correct today, wrong soon. Do not rebuild it yet.

`eval/gold-set.json` carries 36 negatives in two buckets, and the split between
them was drawn against **one 600-article faith corpus**:

| bucket | n | meaning |
| --- | ---: | --- |
| `false_positive_expected` | 17 | no Jubilee page could legitimately answer this |
| `honest_weak_match_expected` | 19 | the corpus really uses the word; a weak match is the engine working |

The first bucket is the one that expires. It contains `best pizza recipe`,
`car repair`, `best laptop deals`, `cheap flights to Rome` — all classified as
having no possible Jubilee answer. The network contains **Inspired Daily
Recipes, Inspired Car Care and Inspired Everyday Tech**. Once those are indexed
every one of those queries has a legitimate Jubilee answer, and a gate tuned to
suppress them would be suppressing correct results.

**So the ~15 measured false positives will drop substantially on their own**, not
because precision improved but because the queries stopped being negatives. Any
before/after on the cross-encoder gate that spans a network import is comparing
two different questions.

**Re-author after the network is indexed, not before.** The current set is the
right instrument for the corpus it was written against, and rewriting it now
would mean guessing at content that is not indexed — the same mistake as authoring
gold pairs from search output instead of from articles. What the new set needs:

* negatives drawn from **outside every vertical the network covers**, which is a
  much smaller space once it includes recipes, car care, tech and children's
  content
* the weak-match bucket re-checked per site, since "repair" is a weak match on a
  faith corpus and a **strong** one on Inspired Car Care
* per-site expectations, because a query can be a false positive for one tenant
  and the correct answer for another — which the single-corpus set cannot express

---

## 7. A MiniLM reranker reorders bge-m3 retrieval

**Status 2026-09-14: RESOLVED.** The rerank slot is now a real cross-encoder,
`Xenova/bge-reranker-base` (fp16, GPU). `bge-reranker-v2-m3` still ships no
ONNX build; converting it is the upgrade path.

**Status:** known mismatch, deliberate, resolves with the cross-encoder.

Migration 029 cut the query path over to bge-m3. The reranker did not move: it
stays on the MiniLM stand-in at `:4032` via `RERANK_API_URL`. So retrieval now
ranks in one model's vector space and the rerank stage reorders the top 50 using
another model's.

**The interface makes this safe, and that was checked rather than assumed.**
`rerank(query, documents)` takes **text** — each document is
`title + "\n" + snippet` — and returns `{index, relevance_score}`. No vector
crosses that boundary, so the reranker has no dependency on which model produced
the retrieval it is reordering. Swapping the embedder cannot invalidate it.

It is still a mismatch worth naming, for two reasons:

* The scores are on different scales, which is part of why
  `zone_a_cross_encoder_floor` is `-1` and disabled (item 4). A gate tuned to a
  bi-encoder cosine would not survive the reranker being replaced.
* Holding the reranker constant was the right control for the A/B — it is what
  made the delta attributable to the embedder — but a control chosen for an
  experiment is not automatically the right production configuration.

**Why MiniLM rather than bge-m3 for the rerank.** Measured on 50 realistic
documents: MiniLM **2,550 ms**, bge-m3 **8,375 ms**. Neither is the specified
cross-encoder; the faster one is kept.

### The part that needs attention before production, separately

`TIMEOUTS.rerank` is **2,000 ms** and the MiniLM stand-in needs **2,550 ms** for
a full 50-document zone. `rerank()` returns the input order unchanged on failure
by design (§13.10 makes rerank the first thing to drop under load), so at full
candidate depth **the rerank stage silently does nothing**.

It is not currently failing outright: the gold-set runs show 64 of 67 hits
carrying rerank metadata, because a real candidate list is often shorter than 50
and the documents are shorter than the probe. But it is marginal, and marginal
means non-deterministic — some queries rerank, some do not, and nothing says
which.

Three ways out, none of them chosen yet:

1. Reduce `rerank_candidates` from 50 until the p95 fits inside the budget.
2. Raise `TIMEOUTS.rerank`, which contradicts §13.10's 180 ms budget for the
   stage and only makes sense if the budget itself is being revisited.
3. Wire the real cross-encoder on real hardware, where §13.10's 180 ms is
   plausible. This is the actual fix.

`RERANK_TIMEOUT_MS` exists so an evaluation can hold the stage deterministic;
production still runs at 2,000 ms.

---

## 8. Corrupted-run baseline is unrecoverable

**Status:** closed as unavailable. Not reconstructed, not estimated.

Two chunker defects (frontmatter ingested as prose; line arrays coerced to
comma-joined strings) corrupted the first 6,085 chunks. They were deleted and
`content_hash` cleared on all 600 pages before re-import, so that state cannot be
re-created.

What survives verbatim in the working transcript, for the corrupted run: the full
24-query suite (intent, Zone A count, coverage, top title), hybrid evidence for 6
queries, one stage-by-stage breakdown, 5 semantic-only results, thread
continuation for 6 articles, and **raw snippets for 4 results only**.

So a before/after comparison exists for titles, counts, ranks and scores across
the suite, and for snippets on 4 results. Anything wider would have to be
invented, and is not.

**Lesson for next time:** capture query output to a file before an operation that
invalidates the index. The comparison is cheap to keep and impossible to recover.

---

## 9. RESOLVED — 83 unpublished chunks, removed by the Postgres move

**Status: closed.** Not fixed by a change; it stopped existing.

The 83 chunks belonged to 25 engineering and specification pages that had been
ingested into the PGlite database before the CDN importer existed. They were
`status='unpublished'`, so `servable_pages` excluded them and they could never
appear in a result — but they were still embedded and still occupying the HNSW
graph, where they could take candidate slots that were then discarded.

The move to PostgreSQL re-imported from the CDN only. Confirmed on the new
database:

| | PGlite | Postgres |
| --- | ---: | ---: |
| indexed pages | 600 | 600 |
| chunks | 5,644 | **5,561** |
| non-indexed pages | 25 unpublished, 83 chunks | **5 manifest rows, 0 chunks** |

The 5 remaining non-indexed rows are bookkeeping: one per category, holding the
ETag and Last-Modified state that makes the importer's conditional GET work. They
carry no chunks and are not servable.

**The condition attached to this item is therefore also gone.** It warned that
reducing the `* 3` over-fetch multiplier in `src/query/retrieval.js` would let
unpublished chunks displace real results from a smaller candidate pool. There are
no unpublished chunks, so the multiplier can now be tuned on its own merits. The
over-fetch still exists and is still deliberate — pushing the servability join
into the ANN scan stops the planner using the HNSW index — but it no longer has a
correctness dependency hanging off it.

**Worth keeping as a lesson:** a development database accumulates state that no
migration reproduces. This one carried 25 pages from a superseded ingest path for
weeks. A clean rebuild found them not by detecting them but by not having them.

---

## 10. Semantic-only recall is not stable across index rebuilds

**Do not gate on it.** Hybrid and lexical are the figures.

Moving the same 5,561 chunks from PGlite to PostgreSQL, with byte-identical
vectors and identical configuration, reproduced the served path exactly and moved
semantic-only:

| | PGlite | Postgres | |
| --- | ---: | ---: | --- |
| hybrid recall@10 | 57.6 | 57.6 | **0 pairs crossed @10** |
| lexical recall@10 | 47.1 | 47.1 | **0 pairs crossed @10** |
| semantic recall@10 | 55.3 | 58.8 | 3 pairs crossed |

24 semantic ranks shifted, nearly all by ±1; three crossed the @10 boundary
(`C02` out→2, `C03` 11→10, `X02` out→1).

**The cause is that HNSW is an approximate index.** The graph is built
independently on each database and the build is order- and parallelism-dependent
— PGlite runs with `max_parallel_maintenance_workers=0`, PostgreSQL parallelises.
Different graph, slightly different neighbour sets, slightly different candidate
list. The vectors are identical; the *search over them* is approximate by design.

Why the three modes behave differently is the useful part:

* **lexical is exactly deterministic.** `ts_rank_cd` over `body_tsv` involves no
  approximation, so it reproduced to the decimal.
* **hybrid is anchored.** RRF over two arms absorbs a ±1 shift in one of them; the
  lexical arm holds the ordering steady.
* **semantic-only is exposed.** Nothing else orders it, so every graph difference
  lands directly in the result.

**Consequences:**

* A REINDEX, a restore, a version upgrade or a change to `m`/`ef_construction`
  will move semantic-only recall by a pair or two. That is not a regression.
* An A/B that reports only semantic-only numbers is reporting partly on the index
  build. `eval/run.mjs` prints all three modes for this reason.
* If semantic-only ever needs to be stable — for a controlled experiment rather
  than a headline — the way to get it is `SET LOCAL hnsw.ef_search` high enough
  that the search is effectively exhaustive, at a latency cost that makes it
  useless for anything but measurement.

---

## 11. Measured latency against the §13.10 budgets

**Status 2026-09-14: within budget on production.** With the GPU inference
service over the tunnel and Zone A rerank ON, cache-miss searches measured on
the Contabo box: 288-469 ms (seven queries, 600 pages). §17's 500 ms p95 is
met at this corpus size; the figures below are the laptop measurements that
preceded it.

Every figure below is measured on this machine: AMD Ryzen 9 6900HX, 8 cores,
28.7 GB RAM with ~5.5 GB free, **no NVIDIA GPU** (`nvidia-smi` absent, zero
NVIDIA PnP devices, no CUDA). PostgreSQL 17.11 + pgvector 0.8.6, 5,561 chunks.

| stage | §13.10 budget | measured | over by |
| --- | ---: | ---: | ---: |
| query embedding, cache miss | 60 ms | 179–299 ms | **3–5x** |
| rerank, both zones | 180 ms | 2,550 ms (MiniLM) / 8,375 ms (bge-m3) | **14x / 47x** |
| whole search p95, cache miss (§17) | 500 ms | **2,881 ms** | **5.8x** |

Cold-cache idle, rerank off, 121 real cache misses: p50 1,454 ms, p95 2,881 ms,
p99 4,074 ms. Cache hits: p50 449 ms, p95 1,464 ms.

**A correction to an earlier figure in this build.** A previous reading reported
786 ms p95 for the same configuration. That sample had a 94.8% cache hit rate and
**six** misses — too few to support a percentile, and it was quoted as a headline
anyway. The 2,881 ms figure above comes from 121 misses on a quiet machine, after
a first attempt was discarded for having overlapped with a gold-set run.

**Turning the reranker off did not bring latency near budget**, which was the
hypothesis worth testing and is now answered: it removed ~2.5 s and left 2.9 s.
The remainder is query embedding, HNSW search, fusion and boosting over 5,561
chunks on a laptop CPU. That is the machine, not the design.

None of this is tunable here. It resolves with the Inference API on real
hardware, exactly as the embedding throughput does.

---

## 12. Embedding throughput, measured on both stores

| | ms/chunk | 5,561 chunks | 137,638 chunks (network) |
| --- | ---: | ---: | ---: |
| PGlite | 2,936 | 4.5 h | 112 h / 4.7 days |
| **PostgreSQL 17** | **2,050** | **3.2 h** | **78 h / 3.3 days** |
| §12.2 target | ~153 | — | **under 4 h for 10,000 pages** |

PostgreSQL is **30% faster at the same work**, which was not predicted. The job's
cost is dominated by inference, so the difference is the write path: PGlite's WASM
layer and its single-connection serialisation were taking about a third of it.

The figure for Gabriel is therefore **3.3 days, not the 4.7 first reported** —
corrected downward from measurement rather than left to be corrected later. It is
still roughly **13x** outside §12.2, on hardware that has no GPU to fix it with.

---

## 13. The T1 network is ingested by crawl, not source markdown (D5 still open)

**Status 2026-09-14.** All 56 registered T1 domains are verified by
authoritative list, `active` and Zone A eligible. Only jubileeverse.com has a
source of markdown (the CDN importer); the other 55 have no `source_root`, D5 has
no answer, and the tenant files in `InspireManna.com/tenants/` point at article
roots on local J: drives with `status: planned`. So §9.1's fallback applies:
`ingest_mode = hybrid` with no root crawls the live site.

First pass (crawl fallback, T1 skips the safety gates by design):

| | |
| --- | ---: |
| domains crawled | 50 live of 55 (5 down: 530/502/unreachable) |
| pages indexed | 2,038 (600 CDN + 1,438 crawled), 25 hosts with content |
| chunks embedded | 47,712, all `bge-m3@onnx-fp16` |
| sitemaps found | 16 domains; the rest via link discovery |

Extraction quality on the crawled sites is good: sampled pages are 1,600-2,300
word articles with correct titles. `jubileeverse.com` is now `source_md` so the
crawler skips it (its articles render client-side and came back `thin_content`).
A daily crawl timer runs at 01:00 ahead of the 02:30 embed.

Two crawler bugs surfaced only because a run finally completed on Postgres:
link discovery refetched every unchanged page until the budget ran out
(fixed: the frontier skips pages fetched inside the crawl interval), and
`finishRun` typed one parameter as both int and text (fixed with
`make_interval`).

**Gate interaction, measured:** on the 2,038-page corpus the cross-encoder
scored all fifty on-topic candidates for `ruach hakodesh` below the -6.5 floor
-- a transliterated Hebrew query against English titles is the register bridge
the reranker cannot see. The gate now stands down for any query the lexicon
recognises (`coverage.js crossEncoderGate`, `lexiconHit`); off-topic queries hit
no concept and are still gated.

**Still open:** D5 (a markdown source per domain), and the 5 domains that were
down at crawl time.
