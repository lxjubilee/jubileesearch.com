// Tests for the parts of the query pipeline that do no I/O.
//
// These are the acceptance criteria that can be checked without a database:
// scripture routing and its refusal to guess (16), Zone A coverage sizing and
// the floor (13), host diversity, and the normalisation that everything else
// depends on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalize, tokenize, detectLanguage } from '../src/text/normalize.js';
import { parseReference } from '../src/text/scripture.js';
import { classify, fusionWeights, cacheTtlSeconds } from '../src/query/intent.js';
import { zoneASize, diversify, assembleZoneA, assembleZoneB, preferSite } from '../src/query/coverage.js';
import { groupToTsquery } from '../src/query/lexicon.js';
import { truncateAtSentence } from '../src/query/retrieval.js';
import { rankingDefaults as cfg } from '../src/config.js';

describe('normalize', () => {
  test('trims, lowercases, unaccents and collapses whitespace', () => {
    const r = normalize('  Ce  Înseamnă   Pocăință?  ');
    assert.equal(r.normalized, 'ce inseamna pocainta');
  });

  test('keeps reference punctuation in the routable form only', () => {
    const r = normalize('John 3:16');
    assert.equal(r.normalized, 'john 3 16');
    assert.equal(r.routable, 'john 3:16');
  });

  test('does not decompose Devanagari', () => {
    // NFD-stripping combining marks here would delete the vowel signs, which
    // are letters. The string must come through intact.
    const r = normalize('हिन्दी में क्षमा');
    assert.equal(r.normalized, 'हिन्दी में क्षमा');
  });

  test('strips Romanian diacritics so lexicon terms match', () => {
    assert.equal(normalize('Rugăciune și Credință').normalized, 'rugaciune si credinta');
  });

  test('tokenize yields unigrams, bigrams and trigrams', () => {
    const t = tokenize('day of atonement');
    assert.ok(t.includes('day'));
    assert.ok(t.includes('day of'));
    assert.ok(t.includes('day of atonement'));
  });

  test('detects language by script and by stopword', () => {
    assert.equal(detectLanguage('हिन्दी में क्षमा'), 'hi');
    assert.equal(detectLanguage('ce este pocainta si de ce'), 'ro');
    assert.equal(detectLanguage('what is the meaning of grace'), 'en');
    assert.equal(detectLanguage('shalom', 'ro'), 'ro', 'falls back to the hint');
    assert.equal(detectLanguage('shalom'), 'en', 'then to English');
  });
});

describe('scripture reference parsing', () => {
  const cases = [
    ['john 3:16', 'John 3:16'],
    ['jn 3:16', 'John 3:16'],
    ['1 john 4:8', '1 John 4:8'],
    ['1john 4:8', '1 John 4:8'],
    ['first john 4:8', '1 John 4:8'],
    ['i john 4:8', '1 John 4:8'],
    ['psalm 23', 'Psalms 23'],
    ['tehillim 23', 'Psalms 23'],
    ['ioan 3:16', 'John 3:16'],
    ['romani 8:28', 'Romans 8:28'],
    ['yeshayahu 53:5', 'Isaiah 53:5'],
    ['song of songs 2:1', 'Song Of Songs 2:1'],
    ['matt 5:3-12', 'Matthew 5:3-12'],
    ['genesis 1.1', 'Genesis 1:1'],
  ];
  for (const [input, expected] of cases) {
    test(`parses "${input}"`, () => {
      assert.equal(parseReference(input)?.ref, expected);
    });
  }

  test('a one-chapter book reads a bare number as the verse', () => {
    const r = parseReference('jude 3');
    assert.equal(r.chapter, 1);
    assert.equal(r.verse, 3);
  });

  // "Silence is correct; a wrong verse is not." Each of these must return null.
  const refusals = [
    ['john', 'a book with no chapter is not a reference'],
    ['john 99', 'chapter beyond the book'],
    ['revelation 23', 'Revelation has 22 chapters'],
    ['what does john 3:16 mean for my marriage', 'a question about a verse, not a request for it'],
    ['3:16', 'no book'],
    ['hope 3:16', 'not a book'],
    ['genesis 0:1', 'there is no chapter zero'],
    ['john 3:16-10', 'a range that runs backwards'],
  ];
  for (const [input, why] of refusals) {
    test(`refuses "${input}" — ${why}`, () => {
      assert.equal(parseReference(input), null);
    });
  }
});

describe('intent router', () => {
  const q = (s) => normalize(s);

  test('scripture beats everything', () => {
    assert.equal(classify(q('john 3:16'), 'en').intent, 'scripture');
  });

  test('navigational when a registered domain matched', () => {
    const r = classify(q('jubileeverse'), 'en', { navigational: { host: 'jubileeverse.com' } });
    assert.equal(r.intent, 'navigational');
  });

  test('entity when an alias matched and nothing stronger did', () => {
    assert.equal(classify(q('shavuot'), 'en', { entity: { key: 'shavuot' } }).intent, 'entity');
  });

  test('conversational needs an interrogative and three words', () => {
    assert.equal(classify(q('why do i feel far from god'), 'en').intent, 'conversational');
    assert.equal(classify(q('why suffering'), 'en').intent, 'topical',
      'two words reads as a topic, not a question');
  });

  test('Romanian "de ce" is matched as a phrase', () => {
    assert.equal(classify(q('de ce sunt trist'), 'ro').intent, 'conversational');
  });

  test('conversational leans on the vector path', () => {
    const w = fusionWeights('conversational');
    assert.ok(w.semantic > w.lexical);
    assert.deepEqual(fusionWeights('topical'), { lexical: 1, semantic: 1 });
  });

  test('navigational and entity queries cache for longer', () => {
    assert.equal(cacheTtlSeconds('navigational', cfg), cfg.cache_ttl_navigational_s);
    assert.equal(cacheTtlSeconds('topical', cfg), cfg.cache_ttl_topical_s);
  });
});

describe('Zone A coverage sizing', () => {
  test('sizes by the strength of the best result', () => {
    assert.deepEqual(zoneASize(0.10, cfg), { size: 5, coverage: 'strong' });
    assert.deepEqual(zoneASize(0.03, cfg), { size: 3, coverage: 'moderate' });
    assert.deepEqual(zoneASize(0.02, cfg), { size: 2, coverage: 'weak' });
  });

  test('shows nothing below the floor rather than padding', () => {
    assert.deepEqual(zoneASize(0.001, cfg), { size: 0, coverage: 'none' });
    assert.deepEqual(zoneASize(null, cfg), { size: 0, coverage: 'none' });
  });

  test('assembles the honest empty state', () => {
    const block = assembleZoneA([{ host: 'a.com', score: 0.001 }], cfg);
    assert.equal(block.results.length, 0);
    assert.equal(block.coverage, 'none');
    assert.equal(block.empty_state, true);
    assert.equal(block.label, 'From Jubilee');
  });
});

describe('host diversity', () => {
  const results = [
    { host: 'a.com', score: 9 }, { host: 'a.com', score: 8 }, { host: 'a.com', score: 7 },
    { host: 'a.com', score: 6 }, { host: 'b.com', score: 5 }, { host: 'c.com', score: 4 },
  ];

  test('caps Zone A at three per host', () => {
    const kept = diversify(results, cfg.zone_a_max_per_host);
    assert.equal(kept.filter((r) => r.host === 'a.com').length, 3);
    assert.equal(kept.length, 5);
  });

  test('caps Zone B at two per host', () => {
    assert.equal(diversify(results, cfg.zone_b_max_per_host)
      .filter((r) => r.host === 'a.com').length, 2);
  });

  test('runs before the size cut, so a strong query still fills Zone A', () => {
    // Four results from one host and two from others: with the cap applied
    // first, Zone A shows a.com three times plus b and c, not three results.
    const block = assembleZoneA(results.map((r) => ({ ...r, score: 0.5 })), cfg);
    assert.equal(block.results.length, 5);
    assert.equal(new Set(block.results.map((r) => r.host)).size, 3);
  });

  test('positions are per zone and one-based', () => {
    const block = assembleZoneB(results, cfg, {});
    assert.deepEqual(block.results.map((r) => r.position), [1, 2, 3, 4]);
    assert.equal(block.label, 'From the wider web');
  });
});

describe('lexical query building', () => {
  test('multi-word terms stay phrases', () => {
    assert.equal(groupToTsquery(['holy spirit']), '(holy <-> spirit)');
  });

  test('a group ORs its terms', () => {
    assert.equal(groupToTsquery(['yeshua', 'jesus']), 'yeshua | jesus');
  });

  test('tsquery metacharacters in editorial data cannot break the query', () => {
    const out = groupToTsquery(["o'brien & sons | drop"]);
    assert.ok(!out.includes('&'));
    assert.ok(!out.includes("'"));
  });

  test('an empty group produces an empty string, not a malformed tsquery', () => {
    assert.equal(groupToTsquery(['!!!']), '');
  });
});

describe('snippets', () => {
  test('cuts at a sentence boundary when there is one', () => {
    const text = `${'a'.repeat(120)}. ${'b'.repeat(300)}`;
    assert.ok(truncateAtSentence(text, 200).endsWith('.'));
  });

  test('falls back to a word boundary', () => {
    const out = truncateAtSentence(`${'word '.repeat(100)}`, 200);
    assert.ok(out.length <= 202);
    assert.ok(out.endsWith('…'));
  });

  test('leaves short text alone', () => {
    assert.equal(truncateAtSentence('short enough', 200), 'short enough');
  });
});

describe('widget ordering (§14)', () => {
  const results = [
    { host: 'other.com', score: 0.9, title: 'network best' },
    { host: 'host.com', score: 0.5, title: 'local' },
    { host: 'blog.host.com', score: 0.4, title: 'local subdomain' },
    { host: 'third.com', score: 0.3, title: 'network' },
  ];

  test('the host site leads, and relevance order survives inside each half', () => {
    const ordered = preferSite(results, 'host.com');
    assert.deepEqual(ordered.map((r) => r.title),
      ['local', 'local subdomain', 'network best', 'network']);
  });

  test('a subdomain of the host site counts as local', () => {
    assert.equal(preferSite(results, 'host.com')[1].host, 'blog.host.com');
  });

  test('www is ignored on both sides', () => {
    const ordered = preferSite([{ host: 'www.host.com', score: 1 }, { host: 'x.com', score: 2 }], 'host.com');
    assert.equal(ordered[0].host, 'www.host.com');
  });

  test('no host means no reordering', () => {
    assert.deepEqual(preferSite(results, null).map((r) => r.title), results.map((r) => r.title));
  });

  test('coverage sizing is decided before the reorder, not after', () => {
    // The bug this guards: partition first and a widget on a site whose best
    // local page is weak reads as weak coverage and shrinks Zone A, when the
    // network's actual best answer was strong.
    const strong = results.map((r) => ({ ...r, score: r.host === 'host.com' ? 0.001 : 0.9 }));
    const block = assembleZoneA(strong, cfg, { preferHost: 'host.com' });
    assert.equal(block.coverage, 'strong', 'sizing must read the relevance order');
    assert.equal(block.results[0].host, 'host.com', 'display order must be host-first');
  });
});
