#!/usr/bin/env node
// Local dev server for the public site.
//
// In production the static files are served by nginx and the API answers on
// api.jubileesearch.com through the Cloudflare tunnel. Locally that would mean
// two origins and a CORS dance for no reason, so this serves the site and
// proxies /api/* to the engine on one port.
//
// It also applies the two rewrites the production vhost still needs (see the
// end of engine/README.md), so what runs here behaves like what is deployed
// rather than like what is deployed *today*:
//
//     /search -> search.html
//     /bot    -> bot.html
//
// Run:  npm run site        (then open http://localhost:8080)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

const SITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SITE_PORT ?? 8080);
const API_ORIGIN = process.env.API_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 4038}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// The rewrites nginx does not do yet.
const REWRITES = { '/search': '/search.html', '/bot': '/bot.html', '/': '/index.html' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);

  const target = REWRITES[url.pathname] ?? url.pathname;

  // Contain the served path inside the site root. A dev server is still a
  // server, and `GET /../../.env` is the first thing anyone tries.
  const resolved = join(SITE_ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ''));
  if (!resolved.startsWith(SITE_ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // engine/ holds .env and the source; it is not part of the published site.
  if (resolved.startsWith(join(SITE_ROOT, 'engine') + sep)) {
    res.writeHead(404).end('not found');
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    const ext = resolved.slice(resolved.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${url.pathname}`);
  }

  log(req, res, url.pathname);
});

async function proxy(req, res, url) {
  const body = req.method === 'GET' || req.method === 'HEAD'
    ? undefined
    : await readBody(req);

  try {
    const upstream = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] ?? 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
    log(req, res, url.pathname, '-> api');
  } catch (err) {
    // The most likely cause by far, so say it rather than making the reader
    // guess from ECONNREFUSED.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'the engine API is not answering',
      api_origin: API_ORIGIN,
      hint: 'start it with `npm start` in engine/',
      detail: err.message,
    }));
    log(req, res, url.pathname, '-> api unreachable');
  }
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || undefined));
  req.on('error', reject);
});

const log = (req, res, path, note = '') =>
  console.log(`  ${String(res.statusCode).padEnd(4)} ${req.method.padEnd(5)} ${path} ${note}`);

server.listen(PORT, () => {
  console.log(`
JubileeSearch site   http://localhost:${PORT}
  /                  home
  /search?q=shalom   results
  /bot               crawler information page (spec 9.4)

/api/* proxies to    ${API_ORIGIN}
`);
});
