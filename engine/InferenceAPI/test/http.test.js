// The HTTP contract, against a real socket, with no model loaded.
//
// Everything here is reachable without weights: routing, auth, body handling,
// the error shape, and the two endpoints whose correct answer is a refusal. A
// test that needed a 542 MB download would not be run, and a test that is not
// run is not a test.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'error';          // keep the suite output readable
process.env.PRELOAD = '';                 // load nothing

const { createInferenceServer } = await import('../src/server.js');

let server;
let base;

before(async () => {
  server = createInferenceServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const get = (p) => fetch(`${base}${p}`);
const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('/health', () => {
  test('answers without any model loaded', async () => {
    const r = await get('/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'ok');
    assert.equal(j.service, 'jubilee-inference-api');
    assert.equal(j.spec, '16');
  });

  test('reports model ids and dimensions per role, loaded or not', async () => {
    // The point of /health is that a caller can see what it is talking to
    // BEFORE sending work, including whether the weights are resident yet.
    const j = await (await get('/health')).json();
    assert.ok(j.roles.embed, 'embed role missing');
    assert.equal(typeof j.roles.embed.configured, 'boolean');
    assert.equal(j.roles.embed.dimensions, 1024, 'declared embedding width must be visible');
    assert.equal(j.roles.embed.loaded, false, 'nothing should be loaded in this suite');
    for (const role of ['embed', 'rerank', 'safety']) {
      assert.ok(role in j.roles, `role ${role} absent from /health`);
    }
  });

  test('reports the backend and device, so hardware is visible to an operator', async () => {
    const j = await (await get('/health')).json();
    assert.equal(j.backend.name, 'onnx');
    assert.ok(j.backend.device, 'device must be reported');
    assert.ok(j.backend.runtime.includes('ONNX'));
  });

  test('reports the §13.10 budgets it is measuring itself against', async () => {
    const j = await (await get('/health')).json();
    assert.equal(j.budgets_ms.embedQueryMs, 60);
    assert.equal(j.budgets_ms.rerankMs, 180);
  });

  test('readiness is false while a preloaded role is unloaded', async () => {
    const j = await (await get('/health')).json();
    assert.equal(typeof j.ready, 'boolean');
  });
});

describe('/v1/models', () => {
  test('lists what fills each role', async () => {
    const j = await (await get('/v1/models')).json();
    assert.ok(j.roles.embed.model_id, 'embed model id must be reported');
    assert.equal(j.max_resident, 2);
  });
});

describe('/v1/classify/family-safety', () => {
  test('refuses with 501 rather than approximating', async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. If this ever returns 200 with
    // `safe_for_family: true`, Safety Gate 3 has been replaced by a guess and
    // unsafe pages can reach Zone B while the log says they were checked.
    const r = await post('/v1/classify/family-safety', { text: 'anything at all' });
    assert.equal(r.status, 501);
    const j = await r.json();
    assert.equal(j.code, 'safety_classifier_not_configured');
    assert.match(j.error, /not implemented/);
    assert.doesNotMatch(JSON.stringify(j), /safe_for_family/,
      'a refusal must not contain a verdict field that a caller might read');
  });
});

describe('/v1/rerank', () => {
  test('empty documents is a valid no-op, not an error', async () => {
    const r = await post('/v1/rerank', { query: 'x', documents: [] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.results, []);
    assert.equal(j.reranked, false, 'a caller must be able to tell the stage did not run');
  });

  test('501 when no rerank model is configured', async () => {
    const r = await post('/v1/rerank', { query: 'x', documents: ['a', 'b'] });
    assert.equal(r.status, 501);
    assert.match((await r.json()).error, /no rerank model is configured/);
  });
});

describe('/v1/embeddings', () => {
  test('rejects a missing input with 400 before touching a model', async () => {
    const r = await post('/v1/embeddings', { input: [] });
    assert.equal(r.status, 400);
  });

  test('rejects a non-string input with 400', async () => {
    const r = await post('/v1/embeddings', { input: [{ not: 'a string' }] });
    assert.equal(r.status, 400);
  });
});

describe('transport', () => {
  test('unknown route lists the real ones', async () => {
    const r = await get('/v1/nope');
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.ok(j.routes.includes('POST /v1/embeddings'));
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const r = await fetch(`${base}/v1/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oh no',
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not valid JSON/);
  });

  test('a GET on a POST route is a 404, not a crash', async () => {
    assert.equal((await get('/v1/embeddings')).status, 404);
  });
});

describe('auth', () => {
  test('when a key is set, /health stays open but work does not', async () => {
    const { env } = await import('../src/config.js');
    const original = env.apiKey;
    env.apiKey = 'secret-key';
    try {
      assert.equal((await get('/health')).status, 200, 'a probe must never need a credential');
      assert.equal((await post('/v1/embeddings', { input: ['x'] })).status, 401);
      const ok = await post('/v1/embeddings', { input: [] },
        { authorization: 'Bearer secret-key' });
      assert.equal(ok.status, 400, 'with the key accepted, it should reach validation');
    } finally {
      env.apiKey = original;
    }
  });
});
