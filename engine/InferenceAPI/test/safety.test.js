// The family-safety verdict (src/safety.js) is pure, so it is tested without a
// model in memory. The classify route's behaviour with nothing configured is
// tested through HTTP like everything else.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, ZERO_SHOT_LABELS, UNSAFE_LABELS, SAFE_LABELS } from '../src/safety.js';

process.env.LOG_LEVEL = 'error';
process.env.PRELOAD = '';
process.env.SAFETY_MODEL_REPO = '';
process.env.SAFETY_TOPIC_MODEL_REPO = '';

// Softmax-shaped topic output: `top` gets `p`, the rest share what is left.
function topics(top, p) {
  const rest = (1 - p) / (ZERO_SHOT_LABELS.length - 1);
  const labels = [top, ...ZERO_SHOT_LABELS.filter((l) => l !== top)];
  return { labels, scores: labels.map((l, i) => (i === 0 ? p : rest)) };
}
const heads = (o = {}) => ['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate']
  .map((label) => ({ label, score: o[label] ?? 0.01 }));

describe('verdict()', () => {
  test('a devotional page is safe with high confidence', () => {
    const v = verdict(heads(), topics('christian teaching or devotional', 0.97));
    assert.equal(v.safe_for_family, true);
    assert.ok(v.confidence >= 0.9, `confidence ${v.confidence}`);
    assert.deepEqual(v.flags, []);
    assert.equal(v.categories[0], 'christian-teaching');
    assert.match(v.reason, /No adult, violent/);
  });

  test('an adult solicitation is unsafe even with no toxicity at all', () => {
    const v = verdict(heads(), topics('adult or sexual content', 0.99));
    assert.equal(v.safe_for_family, false);
    assert.ok(v.flags.includes('adult'));
    assert.ok(v.confidence >= 0.9);
  });

  test('a threat is unsafe on the toxicity heads whatever the topic says', () => {
    const v = verdict(heads({ toxic: 0.98, threat: 0.9, insult: 0.6 }), topics('news or current events', 0.6));
    assert.equal(v.safe_for_family, false);
    assert.deepEqual([...v.flags].sort(), ['insult', 'threat', 'toxic']);
  });

  test('gambling and drugs are caught by topic, not toxicity', () => {
    for (const label of ['gambling', 'illegal drugs']) {
      const v = verdict(heads(), topics(label, 0.8));
      assert.equal(v.safe_for_family, false, label);
      assert.ok(UNSAFE_LABELS.includes(label));
    }
  });

  test('a safe page with some unsafe mass lands in the human-review band, not the index', () => {
    // Roughly a quarter of the topic mass on unsafe labels and a mild toxic head: safe, but
    // the engine's 0.70-0.89 band exists for exactly this.
    // Spelled out per label rather than spread evenly, so the fixture does not
    // change meaning every time a label is added to the set.
    const labels = ['bible study or scripture', 'profanity or crude language', ...ZERO_SHOT_LABELS.filter((l) => !['bible study or scripture', 'profanity or crude language'].includes(l))];
    const restUnsafe = labels.slice(2).filter((l) => UNSAFE_LABELS.includes(l)).length;
    const restSafe = labels.length - 2 - restUnsafe;
    const scores = [0.6, 0.15, ...labels.slice(2).map((l) => (UNSAFE_LABELS.includes(l) ? 0.01 : (0.25 - 0.01 * restUnsafe) / restSafe))];
    const v = verdict(heads({ toxic: 0.4 }), { labels, scores });
    assert.equal(v.safe_for_family, true);
    assert.ok(v.confidence >= 0.7 && v.confidence < 0.9, `confidence ${v.confidence}`);
  });

  test('unsafe mass spread over several unsafe labels is still unsafe', () => {
    const labels = ['gambling', 'profanity or crude language', 'adult or sexual content',
      ...ZERO_SHOT_LABELS.filter((l) => !['gambling', 'profanity or crude language', 'adult or sexual content'].includes(l))];
    const scores = [0.3, 0.25, 0.2, ...labels.slice(3).map(() => 0.25 / (labels.length - 3))];
    const v = verdict(heads(), { labels, scores });
    assert.equal(v.safe_for_family, false);
    assert.ok(v.flags.includes('gambling'));
  });

  test('an unsafe topic below the threshold is not a flag on its own', () => {
    // 0.3 on one unsafe label, the rest on safe labels: below the per-label
    // bar and below the spread-mass bar, so not a flag.
    const labels = ['profanity or crude language', ...SAFE_LABELS, ...UNSAFE_LABELS.filter((l) => l !== 'profanity or crude language')];
    const scores = [0.3, ...SAFE_LABELS.map(() => 0.65 / SAFE_LABELS.length), ...UNSAFE_LABELS.slice(1).map(() => 0.05 / 5)];
    const v = verdict(heads(), { labels, scores }, { unsafeTopicThreshold: 0.5 });
    assert.equal(v.safe_for_family, true);
    assert.ok(v.confidence < 0.9, 'but the doubt shows in the confidence');
  });

  test('the shape is the spec\'s JSON and nothing else', () => {
    const v = verdict(heads(), topics('education or reference', 0.9));
    assert.deepEqual(Object.keys(v).sort(), ['categories', 'confidence', 'flags', 'reason', 'safe_for_family']);
    assert.equal(typeof v.reason, 'string');
  });
});

describe('POST /v1/classify/family-safety with nothing configured', () => {
  let server; let base;
  before(async () => {
    const { createInferenceServer } = await import('../src/server.js');
    server = createInferenceServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  test('refuses with 501 and names both variables, rather than guessing', async () => {
    const r = await fetch(`${base}/v1/classify/family-safety`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(r.status, 501);
    const j = await r.json();
    assert.match(JSON.stringify(j), /SAFETY_TOPIC_MODEL_REPO/);
  });

  test('an empty text is a 400 before any model is consulted', async () => {
    const r = await fetch(`${base}/v1/classify/family-safety`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }),
    });
    assert.equal(r.status, 400);
  });
});
