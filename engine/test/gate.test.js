// The Zone A cross-encoder gate (coverage.js crossEncoderGate). Pure, no DB.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crossEncoderGate, assembleZoneA } from '../src/query/coverage.js';

const cfg = {
  zone_a_cross_encoder_floor: -2.0,
  zone_a_max_per_host: 2,
  zone_a_max_results: 5,
  zone_a_strong_threshold: 0.03,
  zone_a_moderate_threshold: 0.02,
  zone_a_relevance_floor: 0.01,
};
const r = (host, score, rerank_score) => ({ host, score, page_id: Math.random(), rerank_score });

describe('Zone A cross-encoder gate', () => {
  test('off at -1: every result passes, even without rerank scores', () => {
    const results = [r('a', 0.04), r('b', 0.03)];
    const g = crossEncoderGate(results, { ...cfg, zone_a_cross_encoder_floor: -1 });
    assert.equal(g.gated, false);
    assert.equal(g.results.length, 2);
  });

  test('no rerank ran: the floor cannot apply and nothing is dropped', () => {
    const g = crossEncoderGate([r('a', 0.04), r('b', 0.03)], cfg);
    assert.equal(g.gated, false);
    assert.equal(g.results.length, 2);
  });

  test('an off-topic query empties Zone A instead of padding it', () => {
    const results = [r('a', 0.04, -7.2), r('b', 0.03, -8.1)];
    const zone = assembleZoneA(results, cfg);
    assert.equal(zone.results.length, 0);
    assert.equal(zone.coverage, 'none');
    assert.equal(zone.empty_state, true);
  });

  test('a strong first result is not followed by pages the reranker rejected', () => {
    const results = [r('a', 0.04, 1.5), r('b', 0.035, -6.0), r('c', 0.03, -0.5)];
    const zone = assembleZoneA(results, cfg);
    assert.deepEqual(zone.results.map((x) => x.host), ['a', 'c']);
    assert.equal('rerank_score' in zone.results[0], false, 'internal score must not leak');
  });
});
