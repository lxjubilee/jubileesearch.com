#!/usr/bin/env node
// Drive the site in a real browser, over the DevTools protocol.
//
// There is no Playwright here and no need for one: Chrome and Edge both speak
// CDP over a WebSocket, and Node has had a WebSocket client built in since 22.
// This is the whole driver.
//
// Usage:
//   node bin/drive.mjs <url> [--width=390] [--height=1400] [--shot=out.png]
//                            [--eval='<expression>'] [--click='<selector>']
//
// The --eval expression runs in the page after the network settles, and its
// result is printed as JSON. That is what makes this a driver rather than a
// screenshot tool: it can answer "is Zone A above Zone B" and "what is
// overflowing" instead of leaving them to be read off a picture.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(3).filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));

const url = process.argv[2];
if (!url) {
  console.error('usage: node bin/drive.mjs <url> [--width=] [--height=] [--shot=] [--eval=] [--click=]');
  process.exit(1);
}

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

const { existsSync } = await import('node:fs');
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error(`No Chromium-based browser found. Tried:\n  ${BROWSERS.join('\n  ')}\nSet BROWSER=<path>.`);
  process.exit(1);
}

const port = 9222 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(join(tmpdir(), 'jubilee-drive-'));

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--no-first-run',
  '--disable-extensions',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${args.width ?? 1280},${args.height ?? 900}`,
  'about:blank',
], { stdio: 'ignore' });

process.on('exit', () => child.kill());

const target = await waitForTarget(port);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('could not attach to the browser'));
});

let nextId = 1;
const pending = new Map();
const events = [];

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  } else if (data.method) {
    events.push(data);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

// --window-size is not enough. On Windows the browser enforces a minimum window
// width of about 500px, so asking for 390 renders at 500 and then crops the
// screenshot to 390 -- which looks exactly like a horizontal overflow bug and
// is not one. Emulation sets the layout viewport itself, which is what a media
// query reads.
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(args.width ?? 1280),
  height: Number(args.height ?? 900),
  deviceScaleFactor: 1,
  mobile: Number(args.width ?? 1280) < 768,
});

// Console errors from the page are the first thing worth knowing about and the
// easiest thing to miss in a screenshot.
const consoleErrors = [];
ws.addEventListener('message', (msg) => {
  const data = JSON.parse(msg.data);
  if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
    consoleErrors.push(data.params.entry.text);
  }
});

await send('Page.navigate', { url });
await waitForLoad(send);

// The page fetches its results after load, so give the XHR time to land and the
// renderer time to paint it.
await new Promise((r) => setTimeout(r, 1500));

if (args.click) {
  await evaluate(send, `return !!document.querySelector(${JSON.stringify(args.click)})?.click() || true`);
  await new Promise((r) => setTimeout(r, 1200));
}

if (args.eval) {
  const result = await evaluate(send, args.eval);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

if (args.shot) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(args.shot, Buffer.from(data, 'base64'));
  console.error(`screenshot -> ${args.shot}`);
}

if (consoleErrors.length) {
  console.error(`\npage console errors:\n  ${consoleErrors.join('\n  ')}`);
}

ws.close();
child.kill();
process.exit(0);

// ---------------------------------------------------------------------------

async function waitForTarget(port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('browser did not expose a debugging target');
}

function waitForLoad(send) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(async () => {
      const done = await evaluate(send, 'document.readyState === "complete"').catch(() => false);
      if (done || Date.now() - started > 15_000) { clearInterval(poll); resolve(); }
    }, 200);
  });
}

async function evaluate(send, expression) {
  const hasReturn = /(^|[^A-Za-z0-9_$])return([^A-Za-z0-9_$]|$)/.test(expression);
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    // An expression containing `return` is already a function body and goes
    // through untouched; a bare expression has one added. Without the
    // distinction a statement list is wrapped as `return (a(); b)`, which is a
    // syntax error rather than a result.
    expression: `(() => { ${hasReturn ? expression : `return (${expression})`} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluation failed');
  return result.value;
}
