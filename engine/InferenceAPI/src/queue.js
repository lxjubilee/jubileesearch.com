// Priority queue with coalescing batches.
//
// §12.2: "Publish-push chunks jump the queue at priority 1." §16: "Search
// embedding jobs run at low queue priority in an off-peak window, except
// publish-push chunks, which run at priority 1 but are tiny."
//
// So there are three kinds of work and they must not be served first-come:
//
//   realtime (0)  a user is waiting. A query embedding on a cache miss.
//   publish  (1)  an article just went live and should be findable in seconds.
//   bulk   (100)  a backfill of 137,000 chunks that nobody is watching.
//
// WHY THE QUEUE LIVES HERE AND NOT IN THE CALLER. The models are single-
// threaded: one inference at a time, whatever the hardware. If ordering were the
// caller's problem, a backfill and a user query would interleave by luck, and a
// 500 ms budget would be at the mercy of a job with no deadline at all. One
// queue in front of the model is the only place the ordering can be enforced.
//
// STARVATION IS PREVENTED, NOT IGNORED. Strict priority would let a continuous
// stream of queries starve a backfill forever. Every `agingMs`, waiting work is
// promoted one step. A bulk item does not outrank a query, but it stops being
// invisible.

import { env } from './config.js';
import { log } from './log.js';

export const PRIORITY = { realtime: 0, publish: 1, bulk: 100 };

/** Map the API's `priority` field onto a number. Unknown values are bulk. */
export function priorityOf(v) {
  if (v === undefined || v === null || v === '') return PRIORITY.bulk;
  if (typeof v === 'number') return Number.isFinite(v) ? v : PRIORITY.bulk;
  const k = String(v).toLowerCase();
  if (k in PRIORITY) return PRIORITY[k];
  const n = Number(k);
  return Number.isFinite(n) ? n : PRIORITY.bulk;
}

export class InferenceQueue {
  /**
   * @param {object} o
   * @param {(items: any[]) => Promise<any[]>} o.run  process one batch
   * @param {number} o.maxBatch
   * @param {number} o.waitMs   how long to wait for more work before running
   */
  constructor({ run, maxBatch = env.maxBatch, waitMs = env.batchWaitMs, agingMs = 2000, name = 'queue' }) {
    this.run = run;
    this.maxBatch = maxBatch;
    this.waitMs = waitMs;
    this.agingMs = agingMs;
    this.name = name;
    this.items = [];
    this.draining = false;
    this.timer = null;
    this.stats = { enqueued: 0, batches: 0, items: 0, rejected: 0, maxDepth: 0, maxBatchSeen: 0 };
  }

  get depth() { return this.items.length; }

  submit(payload, priority = PRIORITY.bulk) {
    if (this.items.length >= env.maxQueueDepth) {
      this.stats.rejected += 1;
      // Shedding load is better than accepting work that will time out anyway,
      // and a 503 with a depth tells the caller to back off rather than retry
      // into the same wall. This is the failure that turned a slow model into an
      // unresponsive one during the first bge-m3 backfill: aborted requests did
      // not cancel the work, so retries piled on.
      const err = new Error(`inference queue is full (${this.items.length} waiting); retry later`);
      err.status = 503;
      err.retryAfter = 5;
      throw err;
    }
    return new Promise((resolve, reject) => {
      this.items.push({ payload, priority, enqueuedAt: Date.now(), resolve, reject });
      this.stats.enqueued += 1;
      this.stats.maxDepth = Math.max(this.stats.maxDepth, this.items.length);
      this.#schedule();
    });
  }

  #schedule() {
    if (this.draining) return;
    // A realtime item does not wait for a batch to fill. Nothing that could join
    // it is worth the latency of finding out.
    const hasRealtime = this.items.some((i) => i.priority <= PRIORITY.realtime);
    if (hasRealtime || this.items.length >= this.maxBatch) {
      clearTimeout(this.timer); this.timer = null;
      queueMicrotask(() => this.#drain());
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.#drain(); }, this.waitMs);
  }

  /** Effective priority after aging. Lower is more urgent. */
  #effective(item, now) {
    const steps = this.agingMs > 0 ? Math.floor((now - item.enqueuedAt) / this.agingMs) : 0;
    return Math.max(PRIORITY.realtime, item.priority - steps);
  }

  async #drain() {
    if (this.draining || this.items.length === 0) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const now = Date.now();
        this.items.sort((a, b) => {
          const d = this.#effective(a, now) - this.#effective(b, now);
          return d !== 0 ? d : a.enqueuedAt - b.enqueuedAt;     // FIFO within a priority
        });

        // A batch is homogeneous in priority. Mixing a bulk item into a realtime
        // batch would make the user wait for it, which is the thing the queue
        // exists to prevent.
        const head = this.items[0];
        const batch = [];
        while (batch.length < this.maxBatch && this.items.length > 0
               && this.items[0].priority === head.priority) {
          batch.push(this.items.shift());
        }

        const waited = now - head.enqueuedAt;
        const t0 = performance.now();
        try {
          const results = await this.run(batch.map((b) => b.payload));
          const ms = performance.now() - t0;
          this.stats.batches += 1;
          this.stats.items += batch.length;
          this.stats.maxBatchSeen = Math.max(this.stats.maxBatchSeen, batch.length);
          log.debug('queue.batch', {
            queue: this.name, size: batch.length, priority: head.priority,
            waited_ms: Math.round(waited), ms: Math.round(ms),
            per_item_ms: Math.round(ms / batch.length), depth_after: this.items.length,
          });
          batch.forEach((b, i) => b.resolve(results[i]));
        } catch (err) {
          batch.forEach((b) => b.reject(err));
        }
      }
    } finally {
      this.draining = false;
      if (this.items.length > 0) this.#schedule();
    }
  }
}
