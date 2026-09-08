// Serving the embeddable widget (§14).
//
// The script comes from the API origin, not the site origin, for two reasons.
// It is the origin the widget's own XHRs go to, so a host site adds one entry to
// its CSP rather than two; and the CORS allowlist that restricts those XHRs to
// registered Jubilee hosts already lives here, beside the thing it protects.
//
// The file itself is plain ES5 in `../widget/widget.js` and is read once at
// startup. No build step: a widget that needs bundling to be embedded is a
// widget nobody embeds.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let cached = null;

async function widgetSource() {
  if (cached) return cached;
  const source = await readFile(join(here, '..', 'widget', 'widget.js'), 'utf8');
  cached = {
    source,
    etag: `"${createHash('sha256').update(source).digest('base64url').slice(0, 27)}"`,
  };
  return cached;
}

const exact = (path) => (p) => p === path;

export const routes = [
  {
    method: 'GET', match: exact('/widget.js'), auth: false, rateLimit: false,
    handle: async ({ req, res }) => {
      const { source, etag } = await widgetSource();

      // A <script src> is not a CORS request, so no ACAO header is needed to
      // load it. The requests it goes on to make are, and those are governed by
      // the allowlist in server.js.
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(source),
        etag,
        // Short enough that a fix reaches every embedding site the same day,
        // long enough that a busy host page is not refetching it per view.
        'cache-control': 'public, max-age=900',
        'x-content-type-options': 'nosniff',
      });
      res.end(source);
    },
  },

  {
    // A working example, so an integrator can see the thing running before
    // pasting it into a page they care about. Served from the API origin and
    // pointed at whichever T1 host has the most indexed pages, so it has real
    // results rather than an empty box.
    method: 'GET', match: exact('/widget/demo'), auth: false, rateLimit: false,
    handle: async ({ res, db }) => {
      const { rows } = await db.query(
        `SELECT d.host, count(p.id) AS pages
           FROM domains d
           LEFT JOIN pages p ON p.domain_id = d.id AND p.status = 'indexed'
          WHERE d.tier = 'T1' AND d.status = 'active'
          GROUP BY d.host ORDER BY count(p.id) DESC LIMIT 1`).catch(() => ({ rows: [] }));

      const host = rows[0]?.host ?? 'jubileeverse.com';

      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>JubileeSearch widget</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 760px; margin: 0 auto;
         padding: 48px 24px 96px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  p { color: #4a5766; }
  pre { background: #f4f6f9; border: 1px solid #dde3ea; border-radius: 6px;
        padding: 14px 16px; overflow-x: auto; font-size: 13px; }
  .frame { margin-top: 32px; padding: 24px; border: 1px dashed #c7ced6; border-radius: 8px; }
  .frame > small { color: #8b95a3; display: block; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e8eef5; }
    p { color: #a4b2c2; }
    pre { background: #161d26; border-color: #26323f; color: #e8eef5; }
    .frame { border-color: #333f4d; }
  }
</style></head><body>
<h1>JubileeSearch widget</h1>
<p>Two lines on any registered Jubilee host. The widget searches that site first
and can widen to the whole network.</p>

<pre>&lt;div id="jubilee-search"&gt;&lt;/div&gt;
&lt;script src="https://api.jubileesearch.com/widget.js"
        data-site="${host}"&gt;&lt;/script&gt;</pre>

<p><code>data-site</code> defaults to the page's own hostname, so a site
embedding this on itself can leave it out. <code>data-mount</code> takes a
selector if the container is not <code>#jubilee-search</code>;
<code>data-scope="network"</code> starts widened.</p>

<div class="frame">
  <small>Live, against this engine:</small>
  <div id="jubilee-search"></div>
</div>

<script src="/widget.js" data-site="${host}"></script>
</body></html>`;

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'x-robots-tag': 'noindex',
      });
      res.end(html);
    },
  },
];
