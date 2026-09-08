// Public and admin HTTP API (§14).
//
// Port 4038, which is what ops/config/cloudflare-config.yml already maps
// api.jubileesearch.com to.
//
// ---------------------------------------------------------------------------
// There is deliberately no compatibility shim for the old /api/search/web
// contract that the previous front end called.
//
// That endpoint returned one blended `results` array. Acceptance criterion 12 is
// that "Zone A never renders below Zone B, in any client, at any viewport", and
// a single flat list cannot express that -- a client consuming it has no way to
// know which results were Jubilee's and which were the wider web, which is the
// whole of R1. Serving both shapes would mean the guarantee holds in one client
// and quietly does not in another, which is worse than not serving the old shape
// at all. `js/app.js` has been moved to /api/v1/search instead.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { pool } from '../db.js';
import { env, ranking } from '../config.js';
import { search } from '../query/orchestrator.js';
import { identify, isAdmin, canView } from './auth.js';
import { consume, LIMITS } from './ratelimit.js';
import { routes as adminRoutes } from './routes/admin.js';
import { routes as ingestRoutes } from './routes/ingest.js';
import { routes as publicRoutes } from './routes/public.js';
import { routes as widgetRoutes } from './routes/widget.js';

const ROUTES = [...publicRoutes, ...ingestRoutes, ...adminRoutes, ...widgetRoutes];

const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'malformed request URL' });
  }

  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const route = ROUTES.find((r) => r.method === req.method && r.match(url.pathname));
  if (!route) return send(res, 404, { error: 'not found' });

  try {
    const identity = route.auth === false ? null : await identify(req);

    if (route.right === 'admin' && !isAdmin(identity)) {
      return send(res, 403, { error: 'requires the search_admin right' });
    }
    if (route.right === 'view' && !canView(identity)) {
      return send(res, 403, { error: 'requires the search_viewer or search_admin right' });
    }

    if (route.rateLimit !== false) {
      const authed = Boolean(identity?.authenticated);
      const key = authed ? `id:${identity.jubilee_id}` : `ip:${clientIp(req)}`;
      const { allowed, remaining, retryAfter } =
        consume(key, authed ? LIMITS.authenticated : LIMITS.anonymous);
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      if (!allowed) {
        res.setHeader('Retry-After', String(retryAfter));
        return send(res, 429, { error: 'rate limit exceeded', retry_after: retryAfter });
      }
    }

    const body = route.method === 'POST' || route.method === 'PUT'
      ? await readJson(req) : null;

    const result = await route.handle({
      req, res, url, body, identity, db: pool,
      params: route.params?.(url.pathname) ?? {},
    });

    if (res.writableEnded) return;
    return send(res, result?.status ?? 200, result?.body ?? result);
  } catch (err) {
    if (err.statusCode) return send(res, err.statusCode, { error: err.message });
    console.error(JSON.stringify({
      level: 'error', at: 'api', path: url.pathname, msg: err.message, stack: err.stack,
    }));
    return send(res, 500, { error: 'internal error' });
  } finally {
    console.log(JSON.stringify({
      level: 'info', at: 'api', method: req.method, path: url.pathname,
      status: res.statusCode, ms: Date.now() - started,
    }));
  }
});

// §14: "CORS allowlist restricted to registered Jubilee hosts." The widget on
// another Jubilee site is the reason CORS is open at all; it is not open to the
// web. An unlisted origin gets no CORS headers, which the browser turns into a
// blocked request without this server having to guess at intent.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).hostname.replace(/^www\./, ''); } catch { return; }
  const allowed = env.corsAllowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function clientIp(req) {
  // Behind the Cloudflare tunnel, so the connecting socket is always local.
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  res.end(body);
}

const MAX_BODY = 256 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ parsed: {}, raw: '' });
      try {
        resolve({ parsed: JSON.parse(raw), raw });
      } catch {
        reject(Object.assign(new Error('malformed JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Warm the ranking config before the first request rather than on it.
await ranking(true).catch(() => {});

server.listen(env.port, () => {
  console.log(JSON.stringify({
    level: 'info', at: 'api', msg: `JubileeSearch API listening on :${env.port}`,
  }));
});

// §17 availability: finish in-flight requests before the socket closes, so a
// deploy does not show up as a spike of 502s.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export { server, search };
