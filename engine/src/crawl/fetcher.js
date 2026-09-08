// Fetcher Service (§9.4).
//
//   * Sends If-None-Match and If-Modified-Since on every recrawl. A 304 costs
//     one cheap request and skips the entire downstream pipeline.
//   * Honest, fixed User-Agent, with a public bot page behind it.
//   * Honours robots.txt including Crawl-delay, and X-Robots-Tag and
//     <meta name="robots">.
//   * Global and per-host rate limits, both runtime configurable.
//   * Exponential backoff on 429 and 5xx. Three consecutive hard failures pause
//     the domain and raise an admin alert.
//   * Response body cap of 5 MB. Content types other than HTML, XHTML, plain
//     text and PDF are skipped.
//   * Images are never fetched.
//
// P6 is a principle, not a setting: "Robots.txt, crawl-delay, and rate limits
// are honored on external domains without exception." The politeness lock below
// is what makes that true under concurrency -- without it, four workers on the
// same host each honour a 1-second delay and the host still sees four requests
// a second.

import { acceptsContentType } from './policy.js';
import { parseRobots, isAllowed } from './robots.js';
import { detectCharset } from './extractor.js';

export const USER_AGENT = 'JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)';
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.CRAWLER_TIMEOUT_MS ?? 20_000);

// ---------------------------------------------------------------------------
// Per-host politeness lock (§9.3: "only one fetcher touches a host at a time on
// T2 and T3"). A promise chain per host: each request waits for the previous
// one to finish and for the host's delay to elapse.
//
// In-process, like the rate limiter, and with the same caveat: it serialises
// one worker's requests to a host, not the whole fleet's. Running more than one
// crawl worker per host means partitioning the frontier by host, which
// `claimBatch` in frontier.js does.
// ---------------------------------------------------------------------------
const hostChain = new Map();
const hostNextFree = new Map();

function withHostLock(host, delayMs, fn) {
  const previous = hostChain.get(host) ?? Promise.resolve();
  const next = previous.then(async () => {
    const now = Date.now();
    const earliest = hostNextFree.get(host) ?? 0;
    if (earliest > now) await sleep(earliest - now);
    try {
      return await fn();
    } finally {
      hostNextFree.set(host, Date.now() + delayMs);
    }
  }, async () => {
    // A previous failure must not poison the chain for every later request.
    return fn();
  });

  hostChain.set(host, next.catch(() => {}));
  return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// robots.txt, cached per host for the length of a run.
// ---------------------------------------------------------------------------
const robotsCache = new Map();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

export async function robotsFor(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) return cached.value;

  let value;
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
    }, 10_000);

    if (res.status >= 500) {
      // RFC 9309: a server error means the crawler must assume complete
      // disallow. The asymmetry with 4xx is deliberate -- a 5xx is the site
      // failing to answer, and guessing "allowed" against a failing server is
      // exactly when a crawler does the most damage.
      value = { parsed: { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }], crawlDelay: null }], sitemaps: [] },
                unavailable: true };
    } else if (!res.ok) {
      // 404 and friends mean there are no rules. Allow all.
      value = { parsed: { groups: [], sitemaps: [] }, unavailable: false };
    } else {
      const text = await readCapped(res, 512 * 1024);
      value = { parsed: parseRobots(text.toString('utf8')), unavailable: false };
    }
  } catch {
    // Unreachable is not the same as "said nothing". Treated like a 5xx.
    value = { parsed: { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }], crawlDelay: null }], sitemaps: [] },
              unavailable: true };
  }

  robotsCache.set(origin, { at: Date.now(), value });
  return value;
}

export const clearRobotsCache = () => robotsCache.clear();

// ---------------------------------------------------------------------------
// The fetch itself
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {object} domain   row from `domains`
 * @param {object} known    { etag, last_modified_http } from a previous fetch
 * @returns {Promise<object>} a result whose `outcome` is one of
 *   'ok' | 'not_modified' | 'robots_denied' | 'skipped' | 'error'
 */
export async function fetchPage(url, domain, known = {}) {
  let parsed;
  try { parsed = new URL(url); } catch {
    return { outcome: 'skipped', reason: 'unparseable url', retryable: false };
  }

  const origin = parsed.origin;
  const host = parsed.hostname;

  let crawlDelayMs = domain.crawl_delay_ms ?? 1000;

  if (domain.respect_robots !== false) {
    const robots = await robotsFor(origin);
    const verdict = isAllowed(robots.parsed, USER_AGENT, parsed.pathname + parsed.search);

    if (!verdict.allowed) {
      return {
        outcome: 'robots_denied',
        reason: robots.unavailable
          ? 'robots.txt unreachable or 5xx; treating as complete disallow'
          : `robots.txt disallows ${verdict.rule?.path}`,
        retryable: robots.unavailable,
      };
    }
    // A site that asks for a slower pace gets it. The configured delay is a
    // floor, never a ceiling over the site's own request.
    if (verdict.crawlDelaySeconds !== null) {
      crawlDelayMs = Math.max(crawlDelayMs, verdict.crawlDelaySeconds * 1000);
    }
  }

  if (domain.render_js) {
    // §9.4 allows headless rendering only when render_js is set, and notes it
    // costs 10 to 40 times a plain fetch. Playwright is not installed here, and
    // adding a browser pool is a piece of work in its own right. Saying so is
    // better than silently indexing an empty shell of a page.
    return {
      outcome: 'skipped',
      reason: 'render_js is set but no headless browser is configured (see engine/README.md)',
      retryable: false,
    };
  }

  return withHostLock(host, crawlDelayMs, async () => {
    const headers = {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8',
      'accept-language': domain.language_hint ? `${domain.language_hint},en;q=0.8` : 'en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
    };
    // Conditional GET. This is the single biggest saving in a recrawl: an
    // unchanged page costs one small response and no extraction, no chunking and
    // no embedding.
    if (known.etag) headers['if-none-match'] = known.etag;
    if (known.last_modified_http) headers['if-modified-since'] = new Date(known.last_modified_http).toUTCString();

    let res;
    try {
      res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, TIMEOUT_MS);
    } catch (err) {
      return { outcome: 'error', reason: err.name === 'AbortError' ? 'timeout' : err.message, retryable: true };
    }

    if (res.status === 304) {
      return { outcome: 'not_modified', status: 304 };
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        outcome: 'error',
        status: res.status,
        reason: `server returned ${res.status}`,
        retryable: true,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
      };
    }

    if (res.status === 404 || res.status === 410) {
      // Gone is a fact, not a failure. The caller marks the page `gone`.
      return { outcome: 'gone', status: res.status, reason: `server returned ${res.status}` };
    }

    if (!res.ok) {
      return { outcome: 'error', status: res.status, reason: `server returned ${res.status}`, retryable: false };
    }

    const contentType = res.headers.get('content-type');
    const accepted = acceptsContentType(contentType);
    if (!accepted.accepted) {
      // The body is never read. This is where a 4 GB video would otherwise be
      // downloaded to discover it is a video.
      res.body?.cancel?.().catch(() => {});
      return { outcome: 'skipped', status: res.status, reason: accepted.reason, retryable: false };
    }

    let buffer;
    try {
      buffer = await readCapped(res, MAX_BYTES);
    } catch (err) {
      return { outcome: 'error', reason: err.message, retryable: false };
    }

    const charset = detectCharset(buffer, contentType);
    const body = accepted.type === 'application/pdf'
      ? buffer
      : decode(buffer, charset);

    return {
      outcome: 'ok',
      status: res.status,
      // A redirect chain means the URL we asked for is not the URL we got. The
      // final one is what gets indexed, so links resolve against the right base.
      final_url: res.url || url,
      content_type: accepted.type,
      charset,
      etag: res.headers.get('etag'),
      last_modified: res.headers.get('last-modified'),
      x_robots_tag: res.headers.get('x-robots-tag'),
      body,
      bytes: buffer.length,
    };
  });
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Read with a hard cap, aborting mid-stream rather than buffering everything and
// checking afterwards. Content-Length is a hint, not a promise.
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel?.().catch(() => {});
    throw new Error(`body of ${declared} bytes exceeds the ${maxBytes} byte cap`);
  }

  if (!res.body) return Buffer.from(await res.arrayBuffer());

  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`body exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function decode(buffer, charset) {
  if (!charset || charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8');
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    // An unknown label is not worth failing the page over; UTF-8 is right far
    // more often than it is wrong.
    return buffer.toString('utf8');
  }
}

/**
 * Exponential backoff with jitter (§9.4).
 *
 * Jitter matters more than the exponent: a run that queues fifty URLs from one
 * host and hits a 503 will otherwise retry all fifty at the same instant, which
 * is indistinguishable from an attack on a host that is already unwell.
 */
export function backoffMs(attempt, retryAfterMs = null) {
  const CAP_MS = 10 * 60_000;
  if (retryAfterMs) return Math.min(retryAfterMs, 15 * 60_000);
  const base = 2 ** attempt * 1000;
  // The cap goes after the jitter, not before it. Jittering a capped value by
  // up to +50% puts the result back over the cap, which makes the documented
  // ceiling a number the code does not actually honour.
  return Math.min(CAP_MS, Math.round(base * (0.5 + Math.random())));
}
