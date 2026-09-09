// Headless rendering for `render_js` domains (§9.4).
//
// §9.4 permits this only when a domain has `render_js` set, and warns that it
// "costs 10 to 40 times a plain fetch". Both halves are honoured: the fetcher
// reaches this only for such a domain, and one browser is launched and reused
// for the whole crawl rather than one per page.
//
// It exists because the Jubilee network is server-rendered chrome around
// client-rendered content. jubileeverse.com serves an article page whose body
// is the literal text "Loading article…" -- the words are not in the HTML at
// all, not even in the RSC flight payload, and the links to individual articles
// are not in the markup either. A text-only crawler indexes navigation and a
// language dropdown. Rendering is the only way to reach what the site actually
// publishes.
//
// CDP over Node's built-in WebSocket, the same approach as bin/drive.mjs. No
// Playwright, no Puppeteer: this needs one page, one wait, and the serialised
// DOM, and a browser-automation framework to get it would be the largest
// dependency in the repository.
//
// ---------------------------------------------------------------------------
// WHAT THIS STILL REFUSES TO DO
//
//   * Images, media, fonts and stylesheets are blocked at the network layer.
//     P10 is "text only, at any tier", and a renderer that quietly pulls every
//     image on a page would also multiply what the crawl costs the site.
//   * robots.txt is checked BEFORE this is called, by the fetcher, and a
//     disallowed URL never reaches a browser.
//   * The host lock and crawl delay wrap this exactly as they wrap a plain
//     fetch, so a rendered crawl is no faster against a host than a polite one.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  process.env.CRAWLER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 20_000);
// After load, give the client render a moment to put content in the DOM. Too
// short and every page is captured mid-spinner; too long and a crawl of a
// thousand pages spends its life waiting.
const SETTLE_MS = Number(process.env.RENDER_SETTLE_MS ?? 2_500);
const MAX_HTML = 5 * 1024 * 1024;

// Blocked outright. Everything a text index cannot use, and everything P10
// forbids fetching at all.
const BLOCKED = ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.svg',
  '*.ico', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  '*.mp4', '*.webm', '*.mp3', '*.wav', '*.avi', '*.mov'];

let browser = null;   // { child, wsUrl, profile }

export function isAvailable() {
  return Boolean(BROWSERS.find((p) => existsSync(p)));
}

async function launch() {
  if (browser) return browser;

  const bin = BROWSERS.find((p) => existsSync(p));
  if (!bin) {
    throw new Error('no Chromium-based browser found; set CRAWLER_BROWSER to its path');
  }

  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = await mkdtemp(join(tmpdir(), 'jubilee-render-'));
  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    // A crawler is not a person and must not carry a person's fingerprint or
    // cookies between sites.
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,2000',
    'about:blank',
  ], { stdio: 'ignore' });

  // Detach from the event loop. A live ChildProcess handle keeps Node running
  // even with stdio ignored, so without this a crawl job (or a test) finishes
  // its work and then hangs until something kills it. `close()` below is what
  // actually stops the browser; this only stops it holding the process open.
  child.unref();

  // Wait for the debugging endpoint rather than sleeping a guessed interval.
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* not up yet */ }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 250));
  }
  if (!wsUrl) {
    child.kill();
    throw new Error('the headless browser did not expose a debugging endpoint');
  }

  browser = { child, wsUrl, profile, port };
  return browser;
}

/** Shut the shared browser down. The crawl job calls this when it finishes. */
export async function close() {
  if (!browser) return;
  const { child, profile } = browser;
  browser = null;
  try { child.kill(); } catch { /* already gone */ }

  // Fire and forget. A browser that has only just been killed still holds locks
  // inside its profile directory on Windows, and awaiting the delete can block
  // for as long as it takes them to clear -- which turns "the crawl finished"
  // into "the process is still running". A stale temp directory is the cheaper
  // failure, and the OS clears it.
  rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

/**
 * Render one URL and return its serialised DOM.
 *
 * The return shape is the fetcher's, so a rendered page travels through
 * extraction, chunking and indexing by exactly the same path as a fetched one.
 */
export async function render(url, { userAgent, timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  const { wsUrl, port } = await launch();

  // A fresh target per page: a reused tab carries the previous page's script
  // state, and a crawler must not let one site observe another.
  let targetId = null;
  let ws = null;
  const deadline = Date.now() + timeoutMs;

  try {
    const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    targetId = created.id;
    ws = new WebSocket(created.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('could not attach to the page')), 5_000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('could not attach to the page')); };
    });

    let nextId = 1;
    const pending = new Map();
    let loaded = false;
    let status = null;
    let finalUrl = url;
    let contentType = null;

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
        return;
      }
      if (data.method === 'Page.loadEventFired') loaded = true;
      if (data.method === 'Network.responseReceived'
          && data.params?.type === 'Document'
          && status === null) {
        status = data.params.response.status;
        finalUrl = data.params.response.url || url;
        contentType = data.params.response.headers?.['content-type']
          ?? data.params.response.headers?.['Content-Type'] ?? null;
      }
    };

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Network.setUserAgentOverride', { userAgent });
    await send('Network.setBlockedURLs', { urls: BLOCKED });

    await send('Page.navigate', { url });

    // Wait for load, then let the client render settle.
    while (!loaded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!loaded) return { outcome: 'error', reason: 'render timed out before load', retryable: true };
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const { result } = await send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    const html = String(result?.value ?? '');

    if (status === 404 || status === 410) {
      return { outcome: 'gone', status, reason: `server returned ${status}` };
    }
    if (status && status >= 400) {
      return { outcome: 'error', status, reason: `server returned ${status}`, retryable: status >= 500 };
    }
    if (html.length > MAX_HTML) {
      return { outcome: 'skipped', status, reason: `rendered DOM exceeds ${MAX_HTML} bytes`, retryable: false };
    }

    return {
      outcome: 'ok',
      status: status ?? 200,
      final_url: finalUrl,
      content_type: 'text/html',
      charset: 'utf-8',
      // A rendered page has no meaningful validators: the DOM is a function of
      // when it was captured, not of an entity tag. Returning null keeps the
      // conditional-GET path honest instead of revalidating against a header
      // that describes the shell rather than the content.
      etag: null,
      last_modified: null,
      x_robots_tag: null,
      body: html,
      bytes: Buffer.byteLength(html),
      rendered: true,
    };
  } catch (err) {
    return { outcome: 'error', reason: `render failed: ${err.message}`, retryable: true };
  } finally {
    try { ws?.close(); } catch { /* already closed */ }
    if (targetId) {
      await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
    }
  }
}
