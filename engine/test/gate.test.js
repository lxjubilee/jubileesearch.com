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

  test('a query the lexicon recognises is never gated, whatever the reranker says', () => {
    // "ruach hakodesh" against English titles: on-topic by construction, and
    // exactly where the cross-encoder scores every candidate below the floor.
    const results = [r('a', 0.04, -8.9), r('b', 0.03, -9.4)];
    const zone = assembleZoneA(results, cfg, { lexiconHit: true });
    assert.equal(zone.results.length, 2);
    assert.notEqual(zone.coverage, 'none');
  });

  test('a strong first result is not followed by pages the reranker rejected', () => {
    const results = [r('a', 0.04, 1.5), r('b', 0.035, -6.0), r('c', 0.03, -0.5)];
    const zone = assembleZoneA(results, cfg);
    assert.deepEqual(zone.results.map((x) => x.host), ['a', 'c']);
    assert.equal('rerank_score' in zone.results[0], false, 'internal score must not leak');
  });
});

import { vectorGate } from '../src/query/coverage.js';

describe('Zone A vector gate (reranker off)', () => {
  const vcfg = { ...cfg, zone_a_cross_encoder_floor: -1, zone_a_cosine_floor: 0.68 };
  const v = (host, score, cosine, lex_strict = false) => ({ host, score, page_id: Math.random(), cosine, lex_strict });

  test('off at 0', () => {
    const g = vectorGate([v('a', 0.03, 0.5)], { ...vcfg, zone_a_cosine_floor: 0 });
    assert.equal(g.gated, false);
  });

  test('an off-topic query with weak cosines and no full match empties Zone A', () => {
    const out = assembleZoneA([v('a', 0.028, 0.64), v('b', 0.02, 0.61)], vcfg, {});
    assert.equal(out.coverage, 'none');
    assert.equal(out.empty_state, true);
  });

  test('one strong cosine in the top five keeps the block', () => {
    const out = assembleZoneA([v('a', 0.028, 0.64), v('b', 0.02, 0.71)], vcfg, {});
    assert.equal(out.results.length, 2);
    assert.equal(out.coverage, 'moderate');
  });

  test('a page that matched every query term keeps the block on its own', () => {
    const out = assembleZoneA([v('a', 0.028, 0.60, true)], vcfg, {});
    assert.equal(out.results.length, 1);
  });

  test('a lexicon hit bypasses it, like the cross-encoder gate', () => {
    const out = assembleZoneA([v('a', 0.028, 0.60)], vcfg, { lexiconHit: true });
    assert.equal(out.results.length, 1);
  });

  test('it does not run when the cross-encoder gate already did', () => {
    const results = [{ ...v('a', 0.028, 0.60), rerank_score: 1.5 }];
    const out = assembleZoneA(results, { ...vcfg, zone_a_cross_encoder_floor: -2 }, {});
    assert.equal(out.results.length, 1);
  });

  test('the signals never reach the payload', () => {
    const out = assembleZoneA([v('a', 0.028, 0.75, true)], vcfg, {});
    assert.equal('cosine' in out.results[0], false);
    assert.equal('lex_strict' in out.results[0], false);
  });
});
