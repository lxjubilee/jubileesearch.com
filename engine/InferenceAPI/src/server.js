// HTTP transport. Routing, auth, body handling, error shape — nothing else.
//
// Endpoints are versioned under /v1. The contract is the product: callers are
// written against it and it outlives whatever is running behind it.
//
//   GET  /health                      readiness, model ids, dimensions, queues
//   GET  /v1/models                   what fills each role right now
//   POST /v1/embeddings               { input, priority } -> { data: [{index, embedding}] }
//   POST /v1/rerank                   { query, documents, priority } -> { results }
//   POST /v1/classify/family-safety   501, deliberately. See service.js.

import { createServer } from 'node:http';
import { env } from './config.js';
import { log } from './log.js';
import * as service from './service.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;   // a batch of 64 long chunks is ~1 MB

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error('request body too large'); e.status = 413;
        req.destroy(); reject(e); return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch {
        const e = new Error('request body is not valid JSON'); e.status = 400; reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Bearer auth, when a key is configured. Absent key means open — dev default. */
function authorised(req) {
  if (!env.apiKey) return true;
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') && h.slice(7) === env.apiKey;
}

const ROUTES = [
  { method: 'GET', path: '/health', handle: async () => service.health() },
  { method: 'GET', path: '/v1/models', handle: async () => service.models.state() },
  { method: 'POST', path: '/v1/embeddings', handle: (body) => service.embed(body) },
  { method: 'POST', path: '/v1/rerank', handle: (body) => service.rerank(body) },
  { method: 'POST', path: '/v1/classify/family-safety', handle: (body) => service.classifySafety(body) },
];

export function createInferenceServer() {
  return createServer(async (req, res) => {
    const started = performance.now();
    const path = (req.url ?? '').split('?')[0];
    const route = ROUTES.find((r) => r.path === path && r.method === req.method);

    if (!route) {
      return send(res, 404, {
        error: `no route for ${req.method} ${path}`,
        routes: ROUTES.map((r) => `${r.method} ${r.path}`),
      });
    }
    // /health stays open so a probe never needs a credential.
    if (path !== '/health' && !authorised(req)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await route.handle(body);
      const ms = performance.now() - started;
      if (path !== '/health') {
        log.info('http', { method: req.method, path, status: 200, ms: Math.round(ms) });
      }
      return send(res, 200, out);
    } catch (err) {
      const status = err.status ?? 500;
      const ms = performance.now() - started;
      log[status >= 500 ? 'error' : 'warn']('http', {
        method: req.method, path, status, ms: Math.round(ms), err: err.message,
      });
      return send(res, status,
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});
    }
  });
}

export async function start() {
  const server = createInferenceServer();
  await new Promise((resolve) => server.listen(env.port, env.host, resolve));

  log.info('server.listening', {
    url: `http://${env.host}:${env.port}`,
    backend: env.backend,
    device: env.device,
    models: Object.fromEntries(
      Object.entries(env.models).map(([role, m]) => [role, m.repo ? m.id : null])),
    preload: env.preload,
    max_resident_models: env.maxResidentModels,
  });

  // Preload AFTER listening, so /health answers during a cold model load and a
  // supervisor does not kill the process for failing a probe while it works.
  service.models.preload().then(() => {
    log.info('server.ready', { ready: service.models.ready() });
  });

  const shutdown = async (signal) => {
    log.info('server.shutdown', { signal });
    server.close();
    await service.models.disposeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
