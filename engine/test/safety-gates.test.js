// Safety gates (§11.1) and the blocklist stream helpers, without a network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { hostCandidates, gateDomain, gateHeuristics, evaluate, VERDICTS } from '../src/safety/gates.js';
import { splitLines, tarMember, parseLine } from '../src/safety/list-stream.js';

const memoryRules = (over = {}) => ({
  allowHosts: new Set(['biblegateway.com']),
  hosts: [{ pattern: 'bad.example', category: 'adult', severity: 100 },
          { pattern: 'greyzone.example', category: 'drugs', severity: 60 }],
  suffixes: [{ pattern: '.xxx', category: 'adult', severity: 100 }],
  regexes: [],
  keywords: [{ pattern: 'casino', category: 'gambling', severity: 100 },
             { pattern: 'sorcery', category: 'occult', severity: 30 }],
  ...over,
});

describe('gate 1: domain reputation', () => {
  test('a host and every parent domain are candidates, the TLD is not', () => {
    assert.deepEqual(hostCandidates('www.a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com']);
    assert.deepEqual(hostCandidates('example.com'), ['example.com']);
    assert.deepEqual(hostCandidates(''), []);
  });

  test('a listed host is blocked, and so is any subdomain of it', async () => {
    assert.equal((await gateDomain('bad.example', memoryRules())).blocked, true);
    assert.equal((await gateDomain('cdn.bad.example', memoryRules())).blocked, true);
    assert.equal((await gateDomain('notbad.example', memoryRules())).blocked, false);
  });

  test('a low-severity list entry is a reason, not a block', async () => {
    const v = await gateDomain('greyzone.example', memoryRules());
    assert.equal(v.blocked, false);
    assert.equal(v.reasons[0].severity, 60);
  });

  test('a suffix rule blocks the whole top-level domain', async () => {
    assert.equal((await gateDomain('anything.xxx', memoryRules())).blocked, true);
  });

  test('the allow-list wins before any lookup is made', async () => {
    let asked = false;
    const rules = memoryRules({ hostLookup: async () => { asked = true; return []; } });
    const v = await gateDomain('www.biblegateway.com', rules);
    assert.equal(v.allowlisted, true);
    assert.equal(asked, false);
  });

  test('production rules ask the database for the candidates in one call', async () => {
    const seen = [];
    const rules = memoryRules({
      hosts: [],
      hostLookup: async (cands) => { seen.push(cands); return cands.includes('bad.example')
        ? [{ pattern: 'bad.example', category: 'adult', severity: 100 }] : []; },
    });
    const v = await gateDomain('img.bad.example', rules);
    assert.equal(v.blocked, true);
    assert.deepEqual(seen, [['img.bad.example', 'bad.example']]);
  });
});

describe('gate 2 and the ladder', () => {
  test('a hard keyword rejects; a soft one only scores', () => {
    const hard = gateHeuristics({ url: 'https://x.example/casino-night', title: '' }, memoryRules());
    assert.equal(hard.blocked, true);
    const soft = gateHeuristics({ url: 'https://x.example/', title: 'Sorcery in Acts 8' }, memoryRules());
    assert.equal(soft.blocked, false);
    assert.equal(soft.score, 30);
  });

  test('T1 skips every gate', async () => {
    const v = await evaluate({ tier: 'T1', host: 'bad.example', url: 'https://bad.example/' }, memoryRules(), {});
    assert.equal(v.verdict, VERDICTS.SAFE);
  });

  test('T3 on a listed host is unsafe and blocks the domain without a fetch', async () => {
    const v = await evaluate({ tier: 'T3', host: 'bad.example', url: 'https://bad.example/p' }, memoryRules(), {});
    assert.equal(v.verdict, VERDICTS.UNSAFE);
    assert.equal(v.blockDomain, true);
  });

  test('T2 with a soft heuristic hit goes to review, not the index', async () => {
    const v = await evaluate({ tier: 'T2', host: 'ok.example', url: 'https://ok.example/', title: 'Sorcery and Simon' },
      memoryRules(), {});
    assert.equal(v.verdict, VERDICTS.REVIEW);
  });

  test('T3 with no classifier configured is unclassified, never safe (P1)', async () => {
    const v = await evaluate({ tier: 'T3', host: 'ok.example', url: 'https://ok.example/', bodyText: 'hello' },
      memoryRules(), { safety_auto_index_confidence: 0.9, safety_review_confidence: 0.7 });
    assert.equal(v.verdict, VERDICTS.UNCLASSIFIED);
  });
});

describe('list stream helpers', () => {
  const collect = async (gen) => { const out = []; for await (const x of gen) out.push(x); return out; };

  test('splitLines joins chunks that break mid-line', async () => {
    const s = Readable.from([Buffer.from('a.com\nb.c'), Buffer.from('om\nc.com')]);
    assert.deepEqual(await collect(splitLines(s)), ['a.com', 'b.com', 'c.com']);
  });

  test('parseLine understands the three formats and rejects junk', () => {
    assert.deepEqual(parseLine('0.0.0.0 Bad.Example  # x', { format: 'hosts' }), { pattern: 'bad.example', matchType: 'host' });
    assert.equal(parseLine('0.0.0.0 localhost', { format: 'hosts' }), null);
    assert.deepEqual(parseLine('www.site.example', { format: 'domains' }), { pattern: 'site.example', matchType: 'host' });
    assert.equal(parseLine('not a host', { format: 'domains' }), null);
    assert.equal(parseLine('site.example/section/', { format: 'urls' }).matchType, 'regex');
    assert.throws(() => parseLine('x', { format: 'nope' }));
  });

  test('tarMember pulls the named member out of a tar stream', async () => {
    const entry = (name, body) => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 'utf8');
      h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
      h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
      h.write('00000000000\0', 136);
      h.write('        ', 148); h[156] = 0x30;
      const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      Buffer.from(body).copy(data);
      return Buffer.concat([h, data]);
    };
    const tar = Buffer.concat([
      entry('adult/usage', 'domains'),
      entry('adult/domains', 'one.example\ntwo.example\n'),
      entry('adult/urls', 'x.example/y'),
      Buffer.alloc(1024),
    ]);
    // Feed it in awkward pieces so header and body boundaries are crossed.
    const pieces = [];
    for (let i = 0; i < tar.length; i += 300) pieces.push(tar.subarray(i, i + 300));
    const bytes = Buffer.concat(await collect(tarMember(Readable.from(pieces), 'domains')));
    assert.equal(bytes.toString(), 'one.example\ntwo.example\n');
  });
});
