// Embedding job (§12.2).
//
//   * Runs as a background service consuming `chunks WHERE embedded_at IS NULL`
//   * Batches of 32 to 64 chunks per Inference API call
//   * Writes embedding, embedded_at and model_id in one transaction
//   * Retries with backoff; after 3 failures marks the chunk for manual
//     inspection rather than silently dropping it
//   * Publish-push chunks jump the queue at priority 1
//   * Throughput target: the full 10,000-page T1 corpus embeddable in under
//     4 hours on the inference card
//
// §16 constrains when this may run: "Search embedding jobs run at low queue
// priority in an off-peak window, except publish-push chunks, which run at
// priority 1 but are tiny." The window is enforced by the systemd timer that
// invokes this, not here -- but --publish-only exists so the priority-1 path can
// run continuously while the backfill respects the window.

import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from '../db.js';
import { env } from '../config.js';
import { embedBatch } from '../inference/client.js';

const BATCH = Number(process.env.EMBED_BATCH ?? 48);   // §12.2 says 32 to 64
const MAX_ATTEMPTS = 3;

// §12.3 rolling migration. 'live' is the serving column; 'next' is the candidate
// model's, added by migration 028 and read by nothing until a cutover. The job is
// otherwise identical, so it is one column set rather than a second job -- a
// forked copy would drift from this one exactly when it mattered, during a
// migration.
const TARGETS = {
  live: {
    embedding: 'embedding', model: 'model_id', at: 'embedded_at',
    attempts: 'embed_attempts', error: 'embed_error',
  },
  // The retired column after migration 029's cutover. Kept as a target so a
  // rollback can re-embed into it; nothing routine writes here.
  //
  // A FUTURE rolling migration adds its own spare column and its own entry. The
  // names are not recycled: `embedding_next` meaning "the candidate" before a
  // cutover and "the retired model" after one is the kind of ambiguity that gets
  // a column read backwards, which is exactly what 029 had to drop and recreate
  // the embedding_migration view to avoid.
  prev: {
    embedding: 'embedding_prev', model: 'model_id_prev', at: 'embedded_prev_at',
    attempts: 'embed_prev_attempts', error: 'embed_prev_error',
  },
};

// Claim chunks with SKIP LOCKED so several workers can run without coordinating,
// which is the same mechanism §6.1 chose for the crawl queue.
//
// The join to pages reconstructs the embedding prefix. §12.1 requires the chunk
// text to be "prefixed with the page title plus that breadcrumb before
// embedding"; storing the prefixed copy as well would duplicate the title on
// every chunk of every page for no benefit.
const claimSql = (t) => `
  SELECT c.id, c.text, c.heading_path, p.title, p.id AS page_id
  FROM chunks c
  JOIN pages p ON p.id = c.page_id
  LEFT JOIN crawl_queue q ON q.url_hash = p.url_hash
  WHERE c.${t.at} IS NULL
    AND NOT c.boilerplate
    AND c.${t.attempts} < $2
    AND ($3::boolean IS FALSE OR COALESCE(q.priority, 100) = 1)
  ORDER BY COALESCE(q.priority, 100), c.id
  LIMIT $1
  FOR UPDATE OF c SKIP LOCKED`;

export async function runOnce({ publishOnly = false, batch = BATCH, target = 'live' } = {}) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown embed target '${target}'`);
  return withTransaction(async (client) => {
    const { rows } = await client.query(claimSql(t), [batch, MAX_ATTEMPTS, publishOnly]);
    if (rows.length === 0) return { embedded: 0, failed: 0, done: true };

    const texts = rows.map((r) =>
      [[r.title, r.heading_path].filter(Boolean).join(' > '), r.text]
        .filter(Boolean).join('\n\n'));

    let vectors;
    try {
      vectors = await embedBatch(texts, publishOnly ? 1 : 100);
    } catch (err) {
      // The whole batch failed, so the whole batch takes an attempt. The next
      // pass will pick them up again until MAX_ATTEMPTS, after which they stop
      // being claimed and start being reported.
      await client.query(
        `UPDATE chunks SET ${t.attempts} = ${t.attempts} + 1, ${t.error} = $2
          WHERE id = ANY($1::bigint[])`,
        [rows.map((r) => r.id), err.message.slice(0, 500)]);
      return { embedded: 0, failed: rows.length, done: false, error: err.message };
    }

    // One statement for the batch. embedding, embedded_at and model_id are
    // written together (§12.2) so a crash can never leave a vector without the
    // provenance that makes a model migration rolling rather than an outage.
    await client.query(
      `UPDATE chunks c
          SET ${t.embedding} = v.embedding::halfvec,
              ${t.at} = now(),
              ${t.model} = $3,
              ${t.attempts} = 0,
              ${t.error} = NULL
         FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
        WHERE c.id = v.id`,
      [rows.map((r) => r.id), vectors.map((v) => `[${v.join(',')}]`), env.embeddingModel]);

    return { embedded: rows.length, failed: 0, done: false };
  });
}

export async function run({ publishOnly = false, maxBatches = Infinity, target = 'live' } = {}) {
  // Site boilerplate first (migration 036): chunks whose text recurs across a
  // domain's pages are template, not content, and must not reach the index.
  // Idempotent, so every run may call it; a crawl that just ran is the reason to.
  try {
    const { rows } = await pool.query('SELECT mark_boilerplate_chunks(3) AS marked');
    if (Number(rows[0]?.marked) > 0) {
      console.log(JSON.stringify({ level: 'info', at: 'job.embed.boilerplate', marked: Number(rows[0].marked) }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'warn', at: 'job.embed.boilerplate', msg: err.message }));
  }
  let embedded = 0;
  let failed = 0;
  let batches = 0;
  let backoff = 1000;

  // Progress, not just a final tally.
  //
  // This job used to log once, at the end. On a fast provider that is fine; on a
  // slow one it means hours with no output, and the only externally visible sign
  // of life is database write activity -- which is the same whether it is writing
  // VECTORS or writing failure counters. A run that failed 15,348 times looked
  // exactly like a run that was working, from the outside, for as long as it took
  // to notice. So the count of what has actually landed is reported as it goes.
  const started = Date.now();
  let lastLog = 0;
  const progress = (force = false) => {
    if (!force && Date.now() - lastLog < 60_000) return;
    lastLog = Date.now();
    const perChunk = embedded ? (Date.now() - started) / embedded : 0;
    console.log(JSON.stringify({
      level: 'info', at: 'job.embed.progress', target,
      embedded, failed, batches,
      ms_per_chunk: Math.round(perChunk),
      eta_minutes: remaining !== null && perChunk
        ? Math.round((remaining - embedded) * perChunk / 60_000) : null,
    }));
  };

  // One count up front, so the log can say how far through it is rather than
  // only how much it has done.
  const t0 = TARGETS[target];
  const remaining = await pool
    .query(`SELECT count(*)::int n FROM chunks WHERE ${t0.at} IS NULL`)
    .then((r) => r.rows[0].n)
    .catch(() => null);

  while (batches < maxBatches) {
    const result = await runOnce({ publishOnly, target });
    if (result.done) break;
    batches++;
    embedded += result.embedded;
    failed += result.failed;
    progress();

    if (result.failed > 0) {
      // Say so on the FIRST failure, not in the summary. A provider that is
      // rejecting or timing out every batch is a stop-now condition, and the
      // difference between learning that in the first minute and learning it
      // after three retries per chunk is the difference between a fixable
      // misconfiguration and a provider hammered into unresponsiveness.
      if (failed === result.failed) {
        console.warn(JSON.stringify({
          level: 'warn', at: 'job.embed', msg: 'first batch failed', error: result.error,
          hint: 'if this is a timeout, EMBED_BATCH_TIMEOUT_MS and EMBED_BATCH must match '
            + 'the provider actually in use — an aborted fetch does not cancel its work, '
            + 'so retries queue onto it.',
        }));
      }
      // Exponential backoff, capped. The inference card is shared with persona
      // traffic; hammering it while it is struggling makes both worse.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    } else {
      backoff = 1000;
    }
  }
  progress(true);

  const t = TARGETS[target];
  const { rows } = await pool.query(
    `SELECT count(*) AS stuck FROM chunks
      WHERE ${t.at} IS NULL AND ${t.attempts} >= $1`, [MAX_ATTEMPTS]);

  return { target, embedded, failed, batches, needs_manual_inspection: Number(rows[0].stuck) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publishOnly = process.argv.includes('--publish-only');
  const target = process.argv.includes('--next') ? 'next' : 'live';
  const result = await run({ publishOnly, target });
  console.log(JSON.stringify({ level: 'info', at: 'job.embed', ...result }));
  if (result.needs_manual_inspection > 0) {
    console.warn(JSON.stringify({
      level: 'warn', at: 'job.embed',
      msg: `${result.needs_manual_inspection} chunk(s) have failed ${MAX_ATTEMPTS} times and are no longer being retried. ` +
           'They are missing from the vector index while still matching lexically. Inspect chunks.embed_error.',
    }));
  }
  await pool.end();
}
