# Open items

Known gaps as of the first real JubileeVerse CDN index (600 articles, 5,561
chunks, all embedded). None blocks search; all four were found during
verification rather than by a failing test, so they are written down here to
stop them being rediscovered from scratch.

Ordered by what they cost.

---

## 1. The Zone A relevance gate is off — cross-encoder needed

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

## 2. Language: every article defaults to `en`

**Status:** no `language` field exists anywhere in the JubileeVerse CDN bundles —
not in the five `articles.json` manifests, not in any article's YAML frontmatter.
All 600 pages take the domain's `language_hint`, which is `en`.

Detection itself works (script ranges plus a stopword tie-break, en/ro/hi/he),
and `mapToPage` reads a `language` field the moment one appears. There is simply
nothing to detect: the corpus is monolingual as published.

Consequences while this holds:

* `w_lang` (the language-match ranking boost) is constant across the corpus and
  contributes nothing to ordering.
* Cross-language recall (acceptance criterion 9) cannot be exercised.
* The placeholder detector in `src/text/normalize.js` is untested against real
  multilingual content. §6.1 asks for fasttext lid.176 or py3langid before Phase
  3 sign-off; that is worth revisiting only once non-English content exists.

**Fix belongs upstream:** the publisher adds `language` to the frontmatter.

---

## 3. Corrupted-run baseline is unrecoverable

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

## 4. 83 chunks of unpublished pages remain in the HNSW index

**Status:** cosmetic **at the current over-fetch multiplier**. Read the condition
below before changing that multiplier.

The 25 engineering/specification pages are `status = 'unpublished'`, so
`servable_pages` excludes them and they can never appear in a result. Their 83
chunks are still embedded and still in the vector index.

The semantic CTE in `src/query/retrieval.js` searches chunks by tier and joins
`zone_a_pages` **after** the ANN search — deliberately, because pushing the
servability join into the ANN scan stops the planner using the HNSW index. Over-
fetching is what pays for filtering afterwards:

```sql
ORDER BY ch.embedding <=> $vec
LIMIT ${candidates}::int * 3        -- the 3x over-fetch
```

So those 83 chunks can occupy candidate slots that are then discarded. At 3x over-
fetch against 5,561 servable chunks the effect is not measurable.

**The condition under which this stops being cosmetic:** if the `* 3` multiplier
is reduced, unpublished chunks consume a larger share of a smaller candidate pool
and can begin displacing real results. Anyone tuning that multiplier should first
either delete the chunks of unpublished pages, or push a servability predicate
into the ANN scan and re-measure the plan.

Deleting them is safe today (`DELETE FROM chunks WHERE page_id IN (SELECT id FROM
pages WHERE status = 'unpublished')`) — it is not done automatically because a
page can be re-published, and re-chunking is the expensive half of ingest.
