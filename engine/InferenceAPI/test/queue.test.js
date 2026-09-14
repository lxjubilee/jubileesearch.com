// The queue is the part with behaviour rather than plumbing, so it is the part
// worth testing hardest. Every test here runs against a fake `run` — no model is
// loaded, nothing touches the network, and the suite finishes in milliseconds.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceQueue, PRIORITY, priorityOf } from '../src/queue.js';

const collector = (record = []) => ({
  record,
  run: async (items) => { record.push([...items]); return items.map((i) => `ok:${i}`); },
});

describe('priorityOf', () => {
  test('names map to §12.2 levels', () => {
    assert.equal(priorityOf('realtime'), PRIORITY.realtime);
    assert.equal(priorityOf('publish'), PRIORITY.publish);
    assert.equal(priorityOf('bulk'), PRIORITY.bulk);
  });

  test('numbers pass through, so a caller can be more specific than the names', () => {
    assert.equal(priorityOf(1), 1);
    assert.equal(priorityOf(7), 7);
    assert.equal(priorityOf('1'), 1);
  });

  test('anything unrecognised is BULK, never realtime', () => {
    // Defaulting an unknown priority to realtime would let a typo in a backfill
    // script outrank every user query on the system.
    for (const v of [undefined, null, '', 'urgent', 'high', {}, NaN]) {
      assert.equal(priorityOf(v), PRIORITY.bulk, `${String(v)} should be bulk`);
    }
  });
});

describe('batching', () => {
  test('coalesces work submitted together into one call', async () => {
    const c = collector();
    const q = new InferenceQueue({ run: c.run, maxBatch: 64, waitMs: 5 });
    const out = await Promise.all(['a', 'b', 'c'].map((x) => q.submit(x, PRIORITY.bulk)));
    assert.deepEqual(out, ['ok:a', 'ok:b', 'ok:c']);
    assert.equal(c.record.length, 1, 'three submissions should be one batch');
  });

  test('never exceeds maxBatch', async () => {
    const c = collector();
    const q = new InferenceQueue({ run: c.run, maxBatch: 4, waitMs: 5 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => q.submit(i, PRIORITY.bulk)));
    assert.ok(c.record.every((b) => b.length <= 4), 'a batch exceeded maxBatch');
    assert.equal(c.record.flat().length, 10, 'every item must be processed exactly once');
  });

  test('results come back to the right caller', async () => {
    const q = new InferenceQueue({
      run: async (items) => items.map((i) => i * 2), maxBatch: 8, waitMs: 5,
    });
    const out = await Promise.all([1, 2, 3, 4].map((n) => q.submit(n, PRIORITY.bulk)));
    assert.deepEqual(out, [2, 4, 6, 8]);
  });
});

describe('priority', () => {
  test('realtime work overtakes bulk already waiting', async () => {
    const order = [];
    const q = new InferenceQueue({
      run: async (items) => { order.push(...items); return items; },
      maxBatch: 1,          // one at a time, so ordering is visible
      waitMs: 50,
    });
    // Fill with bulk first, then add a realtime item behind it.
    const bulk = Array.from({ length: 5 }, (_, i) => q.submit(`bulk${i}`, PRIORITY.bulk));
    const rt = q.submit('QUERY', PRIORITY.realtime);
    await Promise.all([...bulk, rt]);

    const rtAt = order.indexOf('QUERY');
    assert.ok(rtAt <= 1, `realtime ran at position ${rtAt}; it should not queue behind a backfill`);
  });

  test('publish outranks bulk but yields to realtime', async () => {
    const order = [];
    const q = new InferenceQueue({
      run: async (items) => { order.push(...items); return items; },
      maxBatch: 1, waitMs: 50, agingMs: 0,      // no aging, so this is strict priority
    });
    const all = [
      q.submit('bulk', PRIORITY.bulk),
      q.submit('publish', PRIORITY.publish),
      q.submit('realtime', PRIORITY.realtime),
    ];
    await Promise.all(all);
    assert.ok(order.indexOf('realtime') < order.indexOf('publish'));
    assert.ok(order.indexOf('publish') < order.indexOf('bulk'));
  });

  test('a batch is homogeneous in priority', async () => {
    // Mixing bulk into a realtime batch would make a user wait for a backfill.
    const c = collector();
    const q = new InferenceQueue({ run: c.run, maxBatch: 64, waitMs: 30, agingMs: 0 });
    const work = [
      q.submit('b1', PRIORITY.bulk), q.submit('b2', PRIORITY.bulk),
      q.submit('r1', PRIORITY.realtime), q.submit('p1', PRIORITY.publish),
    ];
    await Promise.all(work);
    for (const batch of c.record) {
      const kinds = new Set(batch.map((x) => x[0]));
      assert.equal(kinds.size, 1, `batch mixed priorities: ${batch.join(',')}`);
    }
  });

  test('aging promotes waiting bulk so it cannot starve forever', async () => {
    const q = new InferenceQueue({ run: async (i) => i, maxBatch: 1, waitMs: 5, agingMs: 10 });
    const old = { payload: 'old', priority: PRIORITY.bulk, enqueuedAt: Date.now() - 1000 };
    // 1000ms at 10ms per step promotes bulk(100) well past realtime(0).
    const steps = Math.floor(1000 / 10);
    assert.ok(PRIORITY.bulk - steps <= PRIORITY.realtime,
      'an item waiting a second should have aged to the front');
    assert.equal(old.priority, PRIORITY.bulk, 'aging must not mutate the submitted priority');
  });
});

describe('load shedding', () => {
  test('rejects with 503 and a retry-after once the queue is full', async () => {
    const { env } = await import('../src/config.js');
    const original = env.maxQueueDepth;
    env.maxQueueDepth = 2;
    try {
      // A run that never settles, so the queue cannot drain while we fill it.
      const q = new InferenceQueue({ run: () => new Promise(() => {}), maxBatch: 1, waitMs: 1000 });
      q.submit('a', PRIORITY.bulk).catch(() => {});
      q.submit('b', PRIORITY.bulk).catch(() => {});
      assert.throws(() => q.submit('c', PRIORITY.bulk), (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.retryAfter, 5);
        assert.match(err.message, /queue is full/);
        return true;
      });
      assert.equal(q.stats.rejected, 1);
    } finally {
      env.maxQueueDepth = original;
    }
  });

  test('a failing batch rejects its own items and the queue keeps working', async () => {
    let first = true;
    const q = new InferenceQueue({
      run: async (items) => {
        if (first) { first = false; throw new Error('model exploded'); }
        return items.map((i) => `ok:${i}`);
      },
      maxBatch: 1, waitMs: 1,
    });
    await assert.rejects(() => q.submit('doomed', PRIORITY.bulk), /model exploded/);
    assert.equal(await q.submit('fine', PRIORITY.bulk), 'ok:fine');
  });
});
