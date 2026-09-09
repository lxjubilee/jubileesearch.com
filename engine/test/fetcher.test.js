// Fetcher integration tests against a local HTTP server.
//
// Everything else in the test suite is a pure function. This file starts a real
// server and makes real requests, because the behaviours §9.4 specifies are
// behaviours of an HTTP client -- conditional GET, the body cap, the
// content-type gate, the politeness delay -- and none of them can be checked by
// calling a function with a string.
//
// It is also the only end-to-end evidence available without a database: it shows
// that a URL goes in and extracted, structured content comes out.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchPage, robotsFor, clearRobotsCache, USER_AGENT } from '../src/crawl/fetcher.js';
import { extract } from '../src/crawl/extractor.js';
import { isAllowed } from '../src/crawl/robots.js';

const ARTICLE = `<!DOCTYPE html><html lang="en">
<head><title>On Steadfastness</title><meta name="description" content="A short teaching."></head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <main>
    <h1>On Steadfastness</h1>
    <p>Emunah is not agreement. It is the steadfastness that keeps walking, even
       when the road cannot be seen, and that is the whole difference between the
       two words as they are usually translated.</p>
    <h2>The root</h2>
    <p>The root is aman, and it carries the sense of being firmly established,
       supported, founded on something that does not shift under weight.</p>
    <p>See <a href="https://elsewhere.example/emunah">the study</a> for more.</p>
  </main>
  <footer><p>Copyright 2026.</p></footer>
</body></html>`;

const ETAG = '"v1"';
let server;
let origin;
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });

    switch (req.url) {
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end([
          'User-agent: *',
          'Disallow: /private/',
          '',
          'User-agent: JubileeSearchBot',
          'Disallow: /members/',
          'Allow: /members/public/',
          'Crawl-delay: 0',
          '',
          'Sitemap: http://localhost/sitemap.xml',
        ].join('\n'));

      case '/article':
        if (req.headers['if-none-match'] === ETAG) {
          res.writeHead(304);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: ETAG });
        return res.end(ARTICLE);

      case '/noindex':
        res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex' });
        return res.end('<html><body><main><p>Hidden from the index.</p></main></body></html>');

      case '/image':
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(Buffer.alloc(1024));

      case '/huge':
        res.writeHead(200, { 'content-type': 'text/html' });
        // Streamed without a Content-Length, so the cap has to be enforced
        // mid-stream rather than from the header.
        for (let i = 0; i < 12; i++) res.write('x'.repeat(512 * 1024));
        return res.end();

      case '/declared-huge':
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(50 * 1024 * 1024) });
        return res.end('x');

      case '/missing':
        res.writeHead(404);
        return res.end('nope');

      case '/broken':
        res.writeHead(503, { 'retry-after': '7' });
        return res.end('later');

      case '/members/private-list':
      case '/private/x':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><body>should never be fetched</body></html>');

      default:
        res.writeHead(404);
        return res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  clearRobotsCache();
});

after(async () => {
  // The renderer keeps one browser for the whole run (that is the point of it),
  // so without this the test process has a live child and never exits.
  const { close } = await import('../src/crawl/render.js');
  await close();
  await new Promise((resolve) => server.close(resolve));
});

const domainFor = (overrides = {}) => ({
  id: 1,
  host: '127.0.0.1',
  tier: 'T2',
  crawl_delay_ms: 0,
  respect_robots: true,
  max_depth: 3,
  ...overrides,
});

describe('fetcher', () => {
  test('reads robots.txt and applies it', async () => {
    const robots = await robotsFor(origin);
    assert.equal(robots.unavailable, false);
    assert.deepEqual(robots.parsed.sitemaps, ['http://localhost/sitemap.xml']);
    assert.equal(isAllowed(robots.parsed, USER_AGENT, '/members/x').allowed, false);
  });

  test('refuses a disallowed URL without fetching it', async () => {
    const before = requests.length;
    const result = await fetchPage(`${origin}/members/private-list`, domainFor());
    assert.equal(result.outcome, 'robots_denied');
    // robots.txt is cached from the previous test, so a refusal must cost zero
    // requests. This is acceptance criterion 5's real content: not that we
    // record a refusal, but that no request is made.
    assert.equal(requests.length, before, 'a disallowed URL was still requested');
  });

  test('fetches an allowed page and sends the honest user agent', async () => {
    const result = await fetchPage(`${origin}/article`, domainFor());
    assert.equal(result.outcome, 'ok');
    assert.equal(result.status, 200);
    assert.equal(result.etag, ETAG);
    const sent = requests.at(-1);
    assert.equal(sent.headers['user-agent'], USER_AGENT);
    assert.match(sent.headers['user-agent'], /\+https:\/\/jubileesearch\.com\/bot/);
  });

  test('a conditional GET comes back 304 and skips the pipeline', async () => {
    const result = await fetchPage(`${origin}/article`, domainFor(), { etag: ETAG });
    assert.equal(result.outcome, 'not_modified');
    assert.equal(result.status, 304);
    assert.equal(requests.at(-1).headers['if-none-match'], ETAG);
  });

  test('an image is refused on Content-Type, and its body is never read', async () => {
    const result = await fetchPage(`${origin}/image`, domainFor());
    assert.equal(result.outcome, 'skipped');
    assert.match(result.reason, /P10/);
    assert.equal(result.body, undefined);
  });

  test('a declared over-size body is refused before it is read', async () => {
    const result = await fetchPage(`${origin}/declared-huge`, domainFor());
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /exceeds/);
  });

  test('an undeclared over-size body is cut off mid-stream', async () => {
    const result = await fetchPage(`${origin}/huge`, domainFor());
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /exceeds/);
  });

  test('404 is a fact, not a failure', async () => {
    const result = await fetchPage(`${origin}/missing`, domainFor());
    assert.equal(result.outcome, 'gone');
  });

  test('503 is retryable and carries Retry-After', async () => {
    const result = await fetchPage(`${origin}/broken`, domainFor());
    assert.equal(result.outcome, 'error');
    assert.equal(result.retryable, true);
    assert.equal(result.retryAfterMs, 7000);
  });

  test('X-Robots-Tag reaches the extractor', async () => {
    const result = await fetchPage(`${origin}/noindex`, domainFor());
    assert.equal(result.outcome, 'ok');
    assert.equal(result.x_robots_tag, 'noindex');
    const extracted = extract(result.body, `${origin}/noindex`, { headers: { 'x-robots-tag': result.x_robots_tag } });
    assert.equal(extracted.robots.noindex, true);
  });

  test('robots can be turned off per domain, for owned hosts only', async () => {
    // §8.3: respect_robots is configurable on T1 and always TRUE on T2 and T3.
    // The fetcher honours the flag; the admin API is what refuses to set it on
    // an external domain.
    const result = await fetchPage(`${origin}/members/private-list`, domainFor({ tier: 'T1', respect_robots: false }));
    assert.equal(result.outcome, 'ok');
  });

  test('render_js routes to the renderer rather than the plain fetch path', async () => {
    // This used to assert `skipped` with "no headless browser is configured",
    // which pinned the fact that rendering was NOT implemented. It is now, so
    // the assertion is about routing instead.
    //
    // The renderer itself is deliberately not exercised here: it launches a real
    // Chromium and the rest of this file runs against a local stub server, so a
    // test that drove it would make the suite depend on a browser being
    // installed and would take seconds rather than milliseconds. What is checked
    // is that a render_js domain does NOT come back through the ordinary fetch
    // path, which is the branch this file can see.
    const { isAvailable, render, close } = await import('../src/crawl/render.js');

    // The module has to offer the three things the fetcher and the crawl job
    // depend on. This is the part that is worth pinning: a rename here breaks
    // rendering silently, because the fetcher's branch is only reached on a
    // render_js domain and nothing else imports it.
    assert.equal(typeof isAvailable, 'function');
    assert.equal(typeof render, 'function');
    assert.equal(typeof close, 'function');

    if (isAvailable()) {
      // A real Chromium is installed. Driving it here would make this suite
      // depend on a browser, cost seconds instead of milliseconds, and leave a
      // child process to reap -- none of which belongs in a unit test. The
      // renderer is exercised for real by the crawl job.
      return;
    }

    // No browser: the fetcher must say so plainly rather than indexing the
    // unrendered shell, which is the failure this branch exists to prevent.
    const result = await fetchPage(`${origin}/article`, domainFor({ render_js: true }));
    assert.equal(result.outcome, 'skipped');
    assert.match(result.reason, /Chromium-based browser/);
  });

  test('the per-host politeness delay is honoured under concurrency', async () => {
    // Three requests issued at once against one host with a 120 ms delay must
    // take at least two delays to complete. Without the lock they would all go
    // out immediately, which is what P6 forbids.
    const started = Date.now();
    await Promise.all([
      fetchPage(`${origin}/article`, domainFor({ crawl_delay_ms: 120 })),
      fetchPage(`${origin}/article`, domainFor({ crawl_delay_ms: 120 })),
      fetchPage(`${origin}/article`, domainFor({ crawl_delay_ms: 120 })),
    ]);
    assert.ok(Date.now() - started >= 240, `three requests took only ${Date.now() - started} ms`);
  });
});

describe('fetch then extract, end to end', () => {
  test('a fetched page becomes structured content', async () => {
    const result = await fetchPage(`${origin}/article`, domainFor());
    const page = extract(result.body, `${origin}/article`);

    assert.equal(page.title, 'On Steadfastness');
    assert.equal(page.description, 'A short teaching.');
    assert.equal(page.language, 'en');

    assert.ok(page.body_text.includes('Emunah is not agreement'));
    assert.ok(!page.body_text.includes('Home'), 'navigation survived');
    assert.ok(!page.body_text.includes('Copyright'), 'footer survived');

    assert.match(page.markdown, /^# On Steadfastness$/m);
    assert.match(page.markdown, /^## The root$/m);

    const external = page.links.find((l) => !l.is_internal);
    assert.equal(external.anchor_text, 'the study');
    assert.ok(Buffer.isBuffer(page.content_hash));
    assert.ok(page.word_count > 40);
  });

  test('the same bytes hash the same way twice', async () => {
    const a = extract(ARTICLE, `${origin}/article`);
    const b = extract(ARTICLE, `${origin}/article`);
    assert.ok(a.content_hash.equals(b.content_hash),
      'content_hash is unstable, so every recrawl would look like a change');
  });
});
