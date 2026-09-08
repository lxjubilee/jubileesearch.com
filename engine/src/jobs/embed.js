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

// Claim chunks with SKIP LOCKED so several workers can run without coordinating,
// which is the same mechanism §6.1 chose for the crawl queue.
//
// The join to pages reconstructs the embedding prefix. §12.1 requires the chunk
// text to be "prefixed with the page title plus that breadcrumb before
// embedding"; storing the prefixed copy as well would duplicate the title on
// every chunk of every page for no benefit.
const CLAIM = `
  SELECT c.id, c.text, c.heading_path, p.title, p.id AS page_id
  FROM chunks c
  JOIN pages p ON p.id = c.page_id
  LEFT JOIN crawl_queue q ON q.url_hash = p.url_hash
  WHERE c.embedded_at IS NULL
    AND c.embed_attempts < $2
    AND ($3::boolean IS FALSE OR COALESCE(q.priority, 100) = 1)
  ORDER BY COALESCE(q.priority, 100), c.id
  LIMIT $1
  FOR UPDATE OF c SKIP LOCKED`;

export async function runOnce({ publishOnly = false, batch = BATCH } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(CLAIM, [batch, MAX_ATTEMPTS, publishOnly]);
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
        `UPDATE chunks SET embed_attempts = embed_attempts + 1, embed_error = $2
          WHERE id = ANY($1::bigint[])`,
        [rows.map((r) => r.id), err.message.slice(0, 500)]);
      return { embedded: 0, failed: rows.length, done: false, error: err.message };
    }

    // One statement for the batch. embedding, embedded_at and model_id are
    // written together (§12.2) so a crash can never leave a vector without the
    // provenance that makes a model migration rolling rather than an outage.
    await client.query(
      `UPDATE chunks c
          SET embedding = v.embedding::halfvec,
              embedded_at = now(),
              model_id = $3,
              embed_attempts = 0,
              embed_error = NULL
         FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
        WHERE c.id = v.id`,
      [rows.map((r) => r.id), vectors.map((v) => `[${v.join(',')}]`), env.embeddingModel]);

    return { embedded: rows.length, failed: 0, done: false };
  });
}

export async function run({ publishOnly = false, maxBatches = Infinity } = {}) {
  let embedded = 0;
  let failed = 0;
  let batches = 0;
  let backoff = 1000;

  while (batches < maxBatches) {
    const result = await runOnce({ publishOnly });
    if (result.done) break;
    batches++;
    embedded += result.embedded;
    failed += result.failed;

    if (result.failed > 0) {
      // Exponential backoff, capped. The inference card is shared with persona
      // traffic; hammering it while it is struggling makes both worse.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    } else {
      backoff = 1000;
    }
  }

  const { rows } = await pool.query(
    `SELECT count(*) AS stuck FROM chunks
      WHERE embedded_at IS NULL AND embed_attempts >= $1`, [MAX_ATTEMPTS]);

  return { embedded, failed, batches, needs_manual_inspection: Number(rows[0].stuck) };
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
  const result = await run({ publishOnly });
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
