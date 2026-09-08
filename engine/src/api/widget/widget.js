/**
 * JubileeSearch embeddable widget (§14).
 *
 * "A small JavaScript snippet other Jubilee sites drop in, calling
 *  /api/v1/search with a `site=` preset for local search and a toggle to widen
 *  to the whole network. In widget mode Zone A is the host site first, then the
 *  rest of the network, then Zone B."
 *
 * Drop-in:
 *
 *   <div id="jubilee-search"></div>
 *   <script src="https://api.jubileesearch.com/widget.js"
 *           data-site="jubileeverse.com"
 *           data-mount="#jubilee-search"></script>
 *
 * Three decisions worth knowing about before editing this file.
 *
 * **Shadow DOM.** Everything renders inside a closed-ish shadow root. This runs
 * on other people's pages, and a widget that inherits a host site's `* { box-sizing }`
 * or donates its own `.result` class to their stylesheet is a support burden for
 * both parties. The shadow boundary makes the CSS a two-way seal.
 *
 * **No images, at any tier.** P10 and acceptance criterion 15 apply here exactly
 * as they do on jubileesearch.com. There is no <img> in this file and none
 * should be added.
 *
 * **The zones keep their order and their labels.** Acceptance criterion 12 says
 * Zone A never renders below Zone B "in any client", and a widget on someone
 * else's site is a client. Criterion 14 says Zone B is always labelled as
 * wider-web content, and that label is not the host site's to remove -- which is
 * why the markup is built here rather than handed over as data.
 */
(function () {
  'use strict';

  // Scoped by the shadow boundary, so these are deliberately plain class
  // names -- nothing here can collide with the host page, and nothing on the
  // host page can reach in. Colours are neutral on purpose: the widget sits
  // on someone else's design and should not fight it.
  var CSS = [
    ".jw{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:680px}",
    ".jw-form{display:flex;gap:8px}",
    ".jw-input{flex:1;min-width:0;padding:9px 12px;border:1px solid #c7ced6;border-radius:6px;font:inherit;background:#fff;color:inherit}",
    ".jw-input:focus{outline:2px solid #1b6ac9;outline-offset:1px;border-color:#1b6ac9}",
    ".jw-go{padding:9px 16px;border:0;border-radius:6px;background:#1b6ac9;color:#fff;font:inherit;font-weight:600;cursor:pointer}",
    ".jw-go:hover{background:#155aad}",
    ".jw-scope{display:flex;gap:6px;margin:10px 0 4px}",
    ".jw-scope button{padding:4px 12px;border:1px solid #c7ced6;border-radius:999px;background:none;font:inherit;font-size:13px;color:#4a5766;cursor:pointer}",
    ".jw-scope button.is-on{border-color:#1b6ac9;color:#1b6ac9;background:#eef5fd}",
    ".jw-zone{margin-top:22px}",
    ".jw-h{margin:0 0 2px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7684}",
    ".jw-zone-b{margin-top:28px;padding-top:18px;border-top:1px solid #e4e9ef}",
    ".jw-note{margin:0 0 14px;font-size:12px;color:#8b95a3}",
    ".jw-r{margin-top:16px}",
    ".jw-t{font-size:16px;color:#1b6ac9;text-decoration:none;font-weight:500}",
    ".jw-t:hover{text-decoration:underline}",
    ".jw-u{font-size:12px;color:#6b7684;margin-top:1px}",
    ".jw-s{margin:3px 0 0;font-size:14px;color:#3d4854}",
    ".jw-s mark{background:none;color:#1a1a1a;font-weight:600}",
    ".jw-muted{color:#6b7684;font-size:14px}",
    "@media (prefers-color-scheme:dark){",
    ".jw{color:#e8eef5}.jw-input{background:#171d25;border-color:#333f4d;color:#e8eef5}",
    ".jw-scope button{border-color:#333f4d;color:#a4b2c2}",
    ".jw-scope button.is-on{background:#15263a;border-color:#4fa8ff;color:#4fa8ff}",
    ".jw-t{color:#4fa8ff}.jw-s{color:#a4b2c2}.jw-s mark{color:#fff}",
    ".jw-zone-b{border-top-color:#26323f}}"
  ].join("");
  var script = document.currentScript;
  if (!script) return;

  var origin = new URL(script.src).origin;
  var site = script.dataset.site || location.hostname.replace(/^www\./, '');
  var mountSelector = script.dataset.mount || '#jubilee-search';
  var placeholder = script.dataset.placeholder || 'Search ' + site;
  var startScope = script.dataset.scope === 'network' ? 'network' : 'site';

  var mount = document.querySelector(mountSelector);
  if (!mount) {
    console.warn('[JubileeSearch] no element matches ' + mountSelector);
    return;
  }

  var root = mount.attachShadow ? mount.attachShadow({ mode: 'open' }) : mount;
  var scope = startScope;
  var lastQuery = '';
  var queryId = null;
  var seq = 0;

  root.innerHTML =
    '<style>' + CSS + '</style>' +
    '<div class="jw">' +
      '<form class="jw-form" role="search">' +
        '<input class="jw-input" type="search" autocomplete="off" placeholder="' + esc(placeholder) + '">' +
        '<button class="jw-go" type="submit">Search</button>' +
      '</form>' +
      '<div class="jw-scope" role="group" aria-label="Search scope">' +
        '<button type="button" data-scope="site">This site</button>' +
        '<button type="button" data-scope="network">Whole network</button>' +
      '</div>' +
      '<div class="jw-out" aria-live="polite"></div>' +
    '</div>';

  var form = root.querySelector('.jw-form');
  var input = root.querySelector('.jw-input');
  var out = root.querySelector('.jw-out');

  paintScope();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    run(input.value.trim());
  });

  root.querySelectorAll('[data-scope]').forEach(function (button) {
    button.addEventListener('click', function () {
      scope = button.dataset.scope;
      paintScope();
      if (lastQuery) run(lastQuery);
    });
  });

  // Click logging (R7). The widget's impressions are the engine's impressions;
  // a click here teaches the ranking exactly as one on jubileesearch.com does.
  out.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('[data-page-id]') : null;
    if (!link || !queryId) return;
    try {
      fetch(origin + '/api/v1/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          query_id: queryId,
          page_id: Number(link.dataset.pageId),
          zone: link.dataset.zone,
          position: Number(link.dataset.position),
          type: 'click'
        })
      });
    } catch (err) { /* a lost click must not break the link */ }
  });

  function paintScope() {
    root.querySelectorAll('[data-scope]').forEach(function (b) {
      var on = b.dataset.scope === scope;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function run(query) {
    if (!query) { out.innerHTML = ''; return; }
    lastQuery = query;

    var ticket = ++seq;
    var params = new URLSearchParams({ q: query });

    if (scope === 'site') {
      // A genuine filter: the engine returns this host's pages and nothing else.
      params.set('site', site);
      params.set('zones', 'A');
    } else {
      // Whole network, but the host site leads Zone A -- the ordering §14 calls
      // widget mode. It reorders what retrieval returned; it never admits a page
      // that retrieval did not.
      params.set('prefer_site', site);
    }

    out.innerHTML = '<p class="jw-muted">Searching…</p>';

    fetch(origin + '/api/v1/search?' + params, { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('search returned ' + res.status);
        return res.json();
      })
      .then(function (data) {
        // A slow request for an earlier query must not overwrite a newer one.
        if (ticket !== seq) return;
        queryId = data.query_id;
        render(data);
      })
      .catch(function () {
        if (ticket !== seq) return;
        out.innerHTML = '<p class="jw-muted">Search is unavailable right now. Please try again shortly.</p>';
      });
  }

  function render(data) {
    var html = '';
    var a = data.zone_a;
    var b = data.zone_b;
    var total = (a && a.results.length) + (b && b.results.length) || 0;

    if (a) {
      if (a.results.length) {
        html += '<section class="jw-zone">'
             +  '<h3 class="jw-h">' + esc(scope === 'site' ? 'On this site' : a.label) + '</h3>'
             +  a.results.map(function (r) { return card(r, 'A'); }).join('')
             +  '</section>';
      } else {
        // The honest empty state travels with the widget (§13.5). A host site
        // showing five weak matches teaches its readers to ignore the box.
        html += '<section class="jw-zone"><h3 class="jw-h">' + esc(a.label) + '</h3>'
             +  '<p class="jw-muted">Nothing here covers that yet.'
             +  (scope === 'site'
                  ? ' Try the whole network.'
                  : '') + '</p></section>';
      }
    }

    // Zone B is only ever below Zone A, and always carries its label.
    if (b && b.results.length) {
      html += '<section class="jw-zone jw-zone-b">'
           +  '<h3 class="jw-h">' + esc(b.label) + '</h3>'
           +  '<p class="jw-note">Outside the Jubilee network, and not Jubilee-endorsed.</p>'
           +  b.results.map(function (r) { return card(r, 'B'); }).join('')
           +  '</section>';
    }

    if (!total) html += '<p class="jw-muted">No results for ' + esc(data.query) + '.</p>';

    out.innerHTML = html;
  }

  function card(result, zone) {
    return '<article class="jw-r">'
      + '<a class="jw-t" href="' + esc(result.url) + '" target="_blank" rel="noopener"'
      +   ' data-page-id="' + result.page_id + '" data-zone="' + zone + '"'
      +   ' data-position="' + result.position + '">'
      +   esc(result.title || result.url)
      + '</a>'
      + '<div class="jw-u">' + esc(result.site_name || result.host) + '</div>'
      + '<p class="jw-s">' + mark(result.snippet) + '</p>'
      + '</article>';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Snippets arrive with <mark> around the matched terms and nothing else.
   * Escape everything, then put only that tag back -- the body text behind a
   * Zone B snippet came off the open web, and §17 requires fetched content is
   * never rendered without sanitisation.
   */
  function mark(snippet) {
    return esc(snippet).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
  }
})();
