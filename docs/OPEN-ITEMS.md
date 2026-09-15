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

**Status 2026-09-15 (later): served in fp16.** The fp32 export is converted
with ONNX Runtime's transformers optimizer (`convert_float_to_float16`,
`keep_io_types`, external data) -- the only converter that survives the 2 GB
protobuf limit; onnxconverter-common fails on deep copy and shape inference.
The fp16 file is 1.1 GB, loads in 8.7 s (fp32: 17.5 s), scores identically
(top pair -2.01 in both) and recall@10 is 59 against 60. `/v1/rerank`, 50
documents: 2300 chars 2.2 s (was 2.75), 1200 chars 0.77 s, 600 chars 0.28 s
(was 0.38). Serving as `bge-reranker-v2-m3@onnx-fp16`, `RERANK_DTYPE=fp16`.

**Status 2026-09-15: the specified cross-encoder is serving.** `BAAI/bge-reranker-v2-m3`
is exported to ONNX by `InferenceAPI/bin/export-reranker.py` (Optimum, fp32,
2.2 GB) into the service's local model directory and runs on the RTX PRO 6000
via DirectML: 50 pairs in 75 ms.
Floor recalibrated on the new scale and left at -6.5: it already empties five
of seventeen off-topic gold queries and costs four of ninety-five positives.

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

## 14. The three sibling systems in §16 do not exist yet

**Status 2026-09-14.** Wiring them is one URL each in the engine's `.env`
(`JSV_API_URL`, `JUBILEEPEDIA_API_URL`, `ANALYTICS_API_URL`); the jobs and the
card are built and tested. Checked on this workstation and on the public hosts:

| system | what exists | what the engine needs |
| --- | --- | --- |
| **JSV Bible** | `jsvbible.com` serves static chapter pages with per-verse markup (`<span class="verse" id="v1">`, `verse-num`). `api.jsvbible.com` answers 502; the API in `W:/JSVBible.com/api` is a stub with `/health` and `/api/v1/status` only. No verse data in the repo (`JubileeTranslations` is a .NET tool). | `GET /passage?book=&chapter=&verse=&verse_end=` → `{book, chapter, verses:[{verse,text}], chapter_url}`. The site's own pages could feed it. |
| **JubileePedia** | `W:/JubileePedia.com` is an empty folder; `jubileepedia.com` does not resolve. | `GET /v1/entities?cursor=` → `{entities:[{entity_key|key, ...}], next}` (see `jobs/entities.js`). |
| **Jubilee Analytics** | No code anywhere on `W:` answers `pages/metrics`; no analytics host resolves. | `POST /v1/pages/metrics {urls, window_days}` → per-URL dwell, scroll depth, bounce, completion (see `jobs/engagement.js`). |

Until then: no scripture card (the query is reported as topical), no entity
panels, and Zone A ranks without the R8 engagement signal. None of these can
be closed from the JubileeSearch side without inventing another product's API.

## 15. Gold set at 100 pairs; recall measured on the network corpus

**Status 2026-09-14.** Acceptance criterion 6 is met in form: 100 pairs, 20
cross-register, 15 cross-language (`eval/gold-set.json`, `cross_language_status`).
The Romanian content is pocaieste.com and pocaintasibotez.com (InspireManna
tenants, `ro-RO`), registered as T1 and crawled: 214 pages.

Three runs on production (bge-m3 fp16, cross-encoder rerank on, hybrid recall@10):

| run | corpus | R@10 | semantic R@10 | notes |
| --- | --- | ---: | ---: | --- |
| `network-2026-09-14` | 2,038 pages, 55,338 chunks | 30 | 9 | before migration 036 |
| `network-boilerplate-2026-09-14` | same, 16,776 live chunks | 38 | 17 | boilerplate flagged |
| `network-jvonly-2026-09-14` | retrieval restricted to jubileeverse.com | 55 | 55 | `EVAL_SITE=jubileeverse.com` |
| `network-chunkrerank-2026-09-14` | whole network | **55** | 51 | reranker reads the best chunk + heading, not the snippet |
| `network-ro-lexicon-2026-09-14` | whole network | 54 | 51 | migration 037: 153 Romanian terms (was 36); cross-language 53% (was 60%: L05 lost to a broader `porunci` expansion), kept because the terms are what readers type |
| `network-clean-2026-09-15` | whole network, 11,776 chunks | 50 | 49 | migration 038: boilerplate stripped at extraction; corpus 55k -> 11.8k chunks; two Romanian targets lost their own titles (see §17) |
| `network-efsearch-2026-09-15` | same | 50 | 49 | migration 039: HNSW search width set per query; no change here because the planner scans this corpus exactly, but it removes a 40-candidate cap that bites at scale (§18) |
| `network-titles-2026-09-15` | same, titles kept | **54** | **54** | a page's own title and H1 are never stripped; cross-language 53% |
| `network-v2m3-2026-09-15` | same | **61** | 58 | `bge-reranker-v2-m3` exported to ONNX (fp32, DirectML, 50 pairs in 75 ms); R@1 40, cross-language 67%, cross-register 60%, conversational 45% |
| `network-v2m3-cap700-2026-09-15` | same | 60 | 57 | reranker reads title + heading + the first 700 chars of the best chunk (`RERANK_TEXT_CHARS`): cache-miss search 0.8-0.95 s instead of 1.2-2.1 s for one point of recall; migration 040 adds 88 Devanagari Hindi terms |
| `network-v2m3-fp16-2026-09-15` | same | 59 | 57 | reranker served in fp16 (§7); R@1 39; the one-pair difference is float noise at the rerank boundary; cross-language 67%, conversational 40% |
| `network-also-accept-2026-09-15` | same | **68** (strict 64) | 65 | gold set 1.1: 21 pairs accept more than one page (see below); R@1 45, conversational 60%, cross-register 65%, cross-language 73% |
| `network-lexany-2026-09-15` | same | 69 (strict 65) | 65 | migration 041: the lexical arm also runs the query's lexemes OR'd at 0.3 weight; lexical-only R@10 39 -> 49, paraphrase 40 -> 50, conversational 60 -> 65 (§20) |
| `network-rerank-desc-2026-09-15` | same | **80** (strict 77) | 77 | the reranker reads the page description as well as title, heading and best chunk; R@5 76, R@3 74; paraphrase 90 (top-5 8/10), conversational 75, topical 93, cross-register 70, cross-language 73 (§20) |

The restricted run matches the 600-page baseline (57.6 on 85 pairs), so the
drop on the whole network is mostly competition: the gold targets are one
specific JubileeVerse article each, and the sibling sites publish articles on
the same themes in the same voice. That is a property of the gold set, not a
retrieval regression, and it is why `EVAL_SITE` exists. Cross-language: 3 of
15 (the ro->en pairs L01-L07 resolve only through the lexicon, and only
`pocăință`/`Duhul Sfânt` are in it -- the Romanian lexicon terms are the next
lever, D9). Conversational remains the weakest type at every corpus size.

**Several right answers (gold set 1.1, 2026-09-15).** The set was authored
against one site, one target per query. On the network the sibling sites
publish on the same themes, so "why does nobody say my name anymore" has a
JubileeCircles message titled almost exactly that, and grading it wrong for
ranking above the JubileeVerse article was grading the corpus, not the engine.
21 pairs now carry `also_accept`: pages found by reading the pages table for
the query's topic, plus a few of the pages that had displaced a target, each
judged on its description. Most displacers were NOT accepted (an article on
"the only one awake in a full house" does not answer "what should I say first
to someone who is lonely"), and the paraphrase pairs stay strict except where
another page is literally the same scenario. `run.mjs` scores the best rank
across the accepted set and prints the strict figure beside it, and every
result file records both. The strict figure moved 59 -> 64 between two runs
of the same configuration an hour apart; the harness shares the GPU with the
scheduled embed job, and a rerank call that misses its 2 s timeout falls back
to fusion order, so runs should be read to within about five pairs.

Criteria 7 (85%), 8 and 10 still fail. Reranking on chunk text was the big
lever (38 -> 55 on the whole network; semantic 17 -> 51). What is left, in
order: site-level boilerplate removal in the extractor; `bge-reranker-v2-m3`;
Hindi terms and content; and gold targets that accept any of several relevant
pages once the corpus has several.

## 16. Every job is scheduled; the content-gap report exists

**Status 2026-09-14.** systemd timers on the Contabo box:

| timer | when | job |
| --- | --- | --- |
| crawl | 01:00 daily | `crawl.js --tier=T1 --seed --max=20000` |
| import-cdn | 02:00 daily | JubileeVerse CDN |
| embed | 02:30 daily | marks boilerplate, then embeds |
| engagement | 03:00 daily | no-op until `ANALYTICS_API_URL` (§14 above) |
| entities | 03:15 daily | no-op until `JUBILEEPEDIA_API_URL` |
| ctr-rollup | 03:30 daily | position-bias corrected CTR |
| retention | Sun 04:00 | §17 purge, what makes the privacy notice true |
| discover | Sun 05:00 | trust-graph nominations for T2 review |
| content-gap | Mon 06:00 | `jobs/content-gap.js` |

**Delivered by e-mail since 2026-09-15.** The Monday job now mails the report
to `CONTENT_GAP_RECIPIENTS` (the two search admins) with the top ten of each
list in the body and the CSV attached, through Mailgun (`src/mail.js`, the
same transport the web tier uses for password resets; the engine `.env`
carries the same keys). Verified with Mailgun's test mode: accepted, message
id returned, delivered to nobody. The first real delivery is Monday
2026-09-21 06:00. No recipients configured means files and console only, as
before; a failed send is logged and the job still succeeds.

The content-gap report (§16, §10.3) is three lists -- nothing came back, the
wider web answered but Jubilee did not, Zone A shown but not clicked -- as
date-stamped JSON and CSV under `REPORTS_DIR` (`/var/lib/jubileesearch/reports`)
with a `latest` copy, and live on the console's Search analytics screen from
the same builder (`GET /api/v1/admin/reports/content-gap`). Delivery to the
writing team is still a file on the server: nobody has said where it should go.

## 17. Site boilerplate is now removed at extraction (migration 038)

**Status 2026-09-15.** Migration 036 only hid repeated chunks from the vector
index; `pages.body_text`, the tsvector and the snippets still carried the
template. Now every markdown block is hashed per page (`page_blocks`), a block
on three or more pages of one domain is boilerplate, and the extractor drops
it before body_text, content_hash and the chunker (`extractor.js
stripBoilerplate`, `store.js siteBoilerplate`, `jobs/crawl.js boilerplateFor`).
The block table was seeded from the text already indexed (1,652 pages, 3,669
repeated blocks) and every crawled page was re-extracted: crawled pages went
from 33.5 chunks each to about 4, which is what a 2,000-word article chunks to.
A site's first two pages keep everything until the third teaches the set; a
forced reingest cleans them afterwards.

The first pass cost recall (54 -> 50): an article's title appears in other
pages' "related" lists, so its block hash was legitimately boilerplate there
and the extractor stripped the H1 off the page that owns it -- a Romanian
target fell from semantic rank 1 to 82. Headings and title matches are now
exempt (list items never are), and after the second re-crawl hybrid recall@10
is 54 with the semantic arm at 54, its best figure on this corpus, on a fifth
of the chunks and with snippets that no longer show menus.

## 18. The vector arm was capped at 40 candidates by a Postgres default

**Status 2026-09-15: fixed (migration 039).** pgvector's HNSW scan returns at
most `hnsw.ef_search` rows -- default 40 -- whatever the query's LIMIT, and
retrieval asks for 300. Retrieval now sets it per query (`SET LOCAL`) from the
`hnsw_ef_search` ranking key (320). On today's 11.8k chunks the planner scans
exactly, so the number did not move; it will matter the day the index is
large enough for the planner to use the HNSW index, which is the day it would
otherwise have silently returned 40.

## 19. Load test at 50 concurrent: the engine is inference-bound; visitor IPs now reach the rate limiter

**Status 2026-09-15.** `eval/load.mjs` runs acceptance 24 as written: 50
concurrent clients for 30 s, first with unique queries (every one a cache
miss), then with twenty repeated queries (every one a hit). Run on the Contabo
box against localhost.

| phase | requests | rps | p50 | p95 | p99 | budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| miss, reranker fp32 | 600 | 20 | 3,200 ms | 4,344 ms | 5,100 ms | 500 ms |
| miss, reranker fp16 | 600 | 20 | 2,867 ms | **3,861 ms** | 4,835 ms | 500 ms |
| hit, reranker fp32 | 11,800 | 401 | 105 ms | 135 ms | 240 ms | 100 ms |
| hit, reranker fp16 | 11,865 | 396 | 115 ms | **180 ms** | 308 ms | 100 ms |

Neither phase meets the budget at this concurrency. The miss phase is bound by
the workstation GPU behind one SSH tunnel: fifty queries each need one query
embedding and one 50-pair rerank, and the service batches them but runs them
one batch at a time (throughput ~20 searches/s). A single cache-miss search
in isolation is 0.8-0.95 s (§11). The hit phase is bound by the box's own
CPU: a cached search still parses, normalises, expands and logs, and at 400
rps the two vCPUs are saturated. fp16 made the miss phase 11% faster; the hit
numbers moved within run-to-run noise.

What was found and fixed on the way: every search reached the engine from the
web tier's own address, so the whole site shared one anonymous bucket of sixty
searches a minute and the first load test returned 429s. `web/lib/api.ts` now
forwards the visitor's `X-Forwarded-For` as nginx presented it, and the engine
normalises `::1` / `::ffff:127.0.0.1` to `127.0.0.1` so loopback is one
address. `RATE_LIMIT_EXEMPT_IPS` exempts listed addresses from the limiter; it
was set to `127.0.0.1` for the tests and removed afterwards.

To meet 500 ms at 50 concurrent the reranker would need to be either nearer
(the tunnel adds ~30 ms per call) and run in parallel sessions, or capped at
fewer candidates per query; to meet 100 ms on hits the box needs more CPU or
the result cache moved in front of the parser. Both are hosting decisions
(§14, D8), not code.

## 20. Conversational and paraphrase queries: two fixes, one experiment

**Status 2026-09-15.** The intent router already does what §13.2 asks
(interrogative + length -> semantic 1.4, lexical 0.6). What was actually wrong
sat on either side of it.

**The lexical arm returned nothing for most questions.** `websearch_to_tsquery`
ANDs every term; "why do people stop showing up after the crisis passes" needs
one page with all of stop, show, crisis and pass. On the gold set the lexical
arm had no rank at all for 14 of 20 conversational pairs, so a question was
carried by the vectors alone and a page the vectors put 20th had nothing to
lift it. Migration 041 adds a third tsquery -- the same lexemes OR'd, built
from `plainto_tsquery` so the config's stopwords are already gone -- at
`lexical_any_weight` 0.30. `ts_rank_cd` on an OR query rewards the page with
the most of the terms, so it is a soft AND: the strict match still wins (it
matches both queries) and a page with most of the words is now a candidate.
Lexical-only R@10 39 -> 49; hybrid moved one pair, because fusion still
handed the order to the reranker, which brings us to:

**The reranker read the wrong 700 characters.** Debug output showed pairs the
vectors ranked first sent to 27th by the cross-encoder ("humming where you are
told to be quiet": fusion 9, reranked 27). The best chunk of a narrative
article is a scene; the sentence that says what the article is about is its
description, which is also what the gold set was authored from. `rerank_text`
is now title + description + heading + best chunk. Hybrid R@10 69 -> 80
(strict 77), R@5 60 -> 76, paraphrase top-5 4/10 -> 8/10, conversational R@10
65 -> 75, topical 83 -> 93. No type lost. Cost: ~150 more characters per pair,
inside the same rerank call.

**Blending fusion order back in does not help.** `eval/rerank-blend.mjs` runs
every gold query once, keeps each candidate's fusion position and cross-encoder
position, and scores rank blends offline. With the description in place, any
weight on fusion position above 0.1 lowers R@3 and empties cross-language
(0.3: cross-language R@5 67 -> 40), because the reranker is what bridges
Romanian queries to English pages. The reranker keeps sole control of order;
the script stays so the question can be re-asked after a model change.

What still misses (hybrid, 20 pairs): T01 T10, C06 C08 C13 C16 C18, P05, X01
X03 X05 X08 X12 X13, N04 N05, L01 L02 L07 L12. Most are pairs whose target page
never enters the 50-candidate set from either arm (C13 "why do people stop
showing up after the crisis passes" -> "Comfort Was Never a Sentence"): a
retrieval gap, not an ordering one, and the next lever is the lexicon (D9), not
the ranker.

## 21. Gate 1 is loaded, acceptance 20 measured: T3 can open when there is something to crawl

**Status 2026-09-15.** Everything §11.1 needs before a T3 page can be admitted
is now in place and measured; what is missing is the T2 whitelist itself,
which is an editorial decision (§11.3), and with no T2 domains the trust graph
has nothing to nominate.

**Blocklist sources verified and loaded.** All six rows in
`bin/blocklist-sources.json` were checked on 2026-09-15 and enabled:
StevenBlack porn and gambling (hosts format, MIT, regenerated daily) and UT1
adult, gambling, malware (published as `phishing/domains`) and drogue
(tar.gz archives, CC BY-SA 4.0, rebuilt daily). The loader streams: fetch ->
gunzip -> a 60-line tar reader -> 5,000-row inserts, so the 4.6-million-line
UT1 adult list never sits in memory. Migration 042 puts a unique index on
(source, match_type, pattern), which is both the de-duplication and the
lookup index. `blocklist_entries` holds 5.06 M rows. A `jubileesearch-
blocklists.timer` refreshes them Saturdays 04:00.

**Gate 1 is a query, not a scan.** `loadRules` used to pull every host rule
into an array and walk it per URL; at five million rows that would have made
the cheapest gate the slowest. It now loads only the small rule sets and
checks a host with one indexed query for itself and each parent domain.
`gateDomain` is async; the two callers await it. 14 new tests cover the gates
and the stream helpers on buffers.

**Acceptance 20 (`eval/unsafe.mjs`, `eval/unsafe-set.json`).** 230 items: 210
hosts drawn deterministically from the six lists, and 20 unlisted pages with
synthetic titles and bodies across the gate-2 categories. Result on
production: 228 of 230 rejected outright (210 at gate 1 before any fetch, 4
at gate 2, 14 at gate 3), 2 quarantined for human review, 0 admitted.

| run | rejected | not rejected | what changed |
| --- | ---: | --- | --- |
| first | 227 | 2 hosts (a sampler bug: `www` stripped as characters), 1 weapons listing read as "news" 0.67 | -- |
| second | 229 | the weapons listing | set regenerated; labels `weapons sales or explosives`, `self-harm or suicide encouragement` added to the classifier |
| third | 228 | a bank-credential phishing page and a child-marriage listing, both "christian teaching" | title and description now precede the body in what gate 3 reads (fixed the weapons page; surfaced these two); migration 043 hard terms for weapons sales and self-harm |
| fourth | 228 | the same two, now at 0.73 and 0.72 | labels `scams, phishing or fraud`, `child exploitation or abuse` added; they moved the two toward the reject line but not over it |

On the strict reading the criterion fails: two pages reach the review queue
instead of the reject pile. On the reading that matters -- can a child see
them -- neither can: review means `status = 'quarantined'`, which no serving
view includes, until a human approves it. The limit is the gate-3 model. The
spec describes "a local LLM call"; the service runs a zero-shot NLI classifier
(`nli-deberta-v3-base`) as the stand-in, and it does not know what a phishing
page or a child-marriage listing is. Swapping in an instruction-following
model behind the same `/v1/classify/family-safety` contract is the fix, and
`eval/unsafe.mjs` is how to prove it. The thresholds were NOT moved to make
the number 230.

**What opens Zone B.** Nothing in the code. `npm run discover -- --dry-run`
nominates zero candidates because the 46k recorded links point at 24 hosts,
all inside the network. The first T2 domains have to be approved by an editor
in the console (Domains -> add as T2), after which the crawl timer fetches
them behind gates 1, 2 and 4, discovery starts nominating their outbound
links for T3, and gate 3 runs on what it promotes.

## 22. Backups exist now; the first restore drill found a real gap

**Status 2026-09-15.** Until today there was no backup of any kind: no dump,
no WAL archive, no copy of the `.env` files. §16 asks for "nightly full plus
WAL archiving, unlogged cache tables excluded, restore drill quarterly,
documented"; acceptance 28 for a documented restore into a clean environment.

`engine/ops/backup.sh` runs nightly at 00:30 (`jubileesearch-backup.timer`):
a custom-format `pg_dump` with the three unlogged cache tables schema-only,
`pg_dumpall -g` for the roles, a `pg_basebackup` tarball, and a 0600 tarball
of the three `.env` files, the nginx site, the systemd units and the postgres
config. Postgres now archives WAL (`archive_mode = on`, five-minute
`archive_timeout`) into `/var/backups/jubileesearch/wal`, so the base backup
plus the archive give point-in-time recovery. Retention: 14 dumps, 7 base
backups, WAL back to the oldest base. First run: 74 s, 118 MB dump, 366 MB
base.

The drill (`engine/ops/restore-drill.sh`, report in `docs/RESTORE-DRILL.md`)
restored the dump into a new database and failed the first time: pgvector is
not a trusted extension, the dump's `CREATE EXTENSION` ran as the application
role and failed, and pg_restore silently skipped the chunks table and both
HNSW indexes while restoring everything else. The script now creates the
extensions as the superuser first; the second run restored every table to the
live row count in 24 s, and the engine's own `search()` answered against the
copy. Next drill December 2026.

**Still open, and a hosting decision (D8):** the backups sit on the same disk
as the database. Nothing copies them off the box. A destination -- object
storage, a second machine, anything -- turns `backup.sh`'s last step into an
rsync; without one, a disk failure loses the database and its backups
together. Point-in-time recovery has a written procedure but has not been
exercised.

