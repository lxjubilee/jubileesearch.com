# Evaluation

Everything here measures search quality. Nothing here is on the request path.

```
# the engine must be STOPPED — PGlite is single-writer
# an inference server must be RUNNING
node bin/dev-inference.mjs                                   # minilm  :4032
INFERENCE_MODEL=bge-m3 INFERENCE_PORT=4033 node bin/dev-inference.mjs

USE_PGLITE=1 PGLITE_DIR=.pglite-dev npm run eval -- <label>
```

| command | |
| --- | --- |
| `npm run eval -- <label>` | score the 85 gold pairs → `results/<label>.json` |
| `npm run eval -- <label> --column=next` | same, against the §12.3 candidate vectors |
| `npm run eval:thresholds` | derive the Zone A coverage thresholds |
| `npm run eval:lexicon` | does the lexicon speak the corpus's spelling? |
| `npm run eval:candidates` | corpus vocabulary the lexicon cannot bridge |
| `npm run eval:contamination` | English terms that also name a story character |
| `npm run eval:proposal` | measured bridging value of proposed concepts |

## Two rules, both learned the hard way

**§17 requires the search path to degrade quietly under an inference outage.
That is right for production and wrong for evaluation. Anything that measures
quality must fail loudly exactly where production is required to fail softly.**

Run through `npm`, never `node eval/run.mjs`. The npm scripts pass
`--env-file-if-exists=.env`; without it `INFERENCE_API_URL` is empty, the
semantic arm and the reranker both degrade silently, and the run still prints a
full table. That happened: the first baseline reported recall@10 = 40.0 with
`hybrid` and `lexical` identical to four decimals, because both were lexical.
`preflight()` now refuses to start unless the embedder answers at 1024
dimensions, the reranker reranks, and `EMBEDDING_MODEL` matches the `model_id` on
the chunks it is about to compare against.

**A number that reaches a migration must come from a committed script.**

Migration 027's thresholds came from scripts in a temp directory. The values are
in version control; the derivation was not. `derive-thresholds.mjs` is where that
now lives, objective stated in the file above the code that applies it.

## `Error: PGlite failed to initialize properly`

Something else already has the database. PGlite is single-writer and the message
does not say so — it reads like corruption and is not.

```
# find the holder: any node process touching this repo's src/ or eval/
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CommandLine | Format-Table -Wrap
```

Usual culprits, in order: the engine (`npm start`), a background job
(`embed.js`, `entities.js`, `crawl.js`), or a previous eval run that was stopped
at the shell but whose **node process outlived the shell that launched it** —
stopping the wrapper does not always stop the child. Kill by PID, then re-run.

A killed writer leaves nothing to repair: an uncommitted transaction rolls back,
and the embed job commits per batch. Verify with `SELECT * FROM
embedding_migration` rather than assuming either way.

**Stale processes also distort timings.** Four abandoned `npm test` runs were
found competing for CPU during a throughput benchmark here. Check the process
list before trusting any latency number from this machine.

## What is measured, and where

Recall@10 is **not** taken from `/api/v1/search`. All 600 articles are on one
host and `zone_a_max_per_host` is 3, so `diversify()` caps Zone A at three
results before coverage sizing runs, whatever `size` asks. The metric is taken on
the reranked candidate list (`rerank_candidates`, 50 deep) — the surface a model
change actually moves. What a reader would see is reported beside it as
`displayed_rank`.

`@3` and `@5` are reported alongside `@10` because Zone A renders at most 5
results and only 3 at moderate coverage. A model that wins at 10 and loses at 3
is worse for the product.

`driftGuard()` asserts the harness still agrees with `search()` on which page
ranks first, so it cannot quietly diverge from production.

## Files

| file | |
| --- | --- |
| `gold-set.json` | 85 pairs, authored from article content. Versioned; diff it in review. |
| `preflight.mjs` | the shared refusal-to-run, and the reasoning behind it |
| `harness.mjs` | steps 1–7 of the orchestrator, minus cache, best bets and zone assembly |
| `run.mjs` | scores the set |
| `derive-thresholds.mjs` | the threshold curve and the chosen point |
| `lexicon-*.mjs` | the lexicon-vs-corpus audits |
| `results/` | one file per run — keep them; they are the before/after record |
