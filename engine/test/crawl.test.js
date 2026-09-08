// Tests for the crawl pipeline's pure parts.
//
// Acceptance criterion 5 -- "Robots.txt is provably honored on external domains,
// evidenced by a test against a controlled disallow rule" -- is the first block
// below. The rest cover the places this pipeline can go quietly wrong: admitting
// an image, following a crawler trap, mistaking a menu for an article, or
// indexing a PDF's font indices as though they were words.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseRobots, isAllowed, groupFor, parseXRobotsTag, parseRobotsDirectives } from '../src/crawl/robots.js';
import { admit, acceptsContentType, nextInterval } from '../src/crawl/policy.js';
import { parseSitemap } from '../src/crawl/sitemap.js';
import { extract, detectCharset } from '../src/crawl/extractor.js';
import { simhash, hammingDistance, bands, toSigned, fromSigned, pickCanonical } from '../src/crawl/simhash.js';
import { extractPdfText, looksLikeText } from '../src/crawl/pdf.js';
import { backoffMs, USER_AGENT } from '../src/crawl/fetcher.js';

const T3 = { id: 1, host: 'example.com', tier: 'T3', max_depth: 2, max_pages: 500, respect_robots: true };

describe('robots.txt', () => {
  // Acceptance criterion 5's controlled disallow rule.
  const controlled = parseRobots(`
    User-agent: *
    Disallow: /private/

    User-agent: JubileeSearchBot
    Disallow: /members/
    Allow: /members/public/
    Crawl-delay: 4
  `);

  test('obeys a disallow rule addressed to this bot', () => {
    assert.equal(isAllowed(controlled, USER_AGENT, '/members/directory').allowed, false);
  });

  test('obeys an allow rule nested inside a disallowed path', () => {
    assert.equal(isAllowed(controlled, USER_AGENT, '/members/public/notes').allowed, true);
  });

  test('a named group replaces the wildcard group entirely', () => {
    // /private/ is disallowed for *, but this bot has its own group and that
    // group says nothing about /private/. Merging the two would be wrong.
    assert.equal(isAllowed(controlled, USER_AGENT, '/private/x').allowed, true);
    assert.equal(isAllowed(controlled, 'SomeOtherBot/1.0', '/private/x').allowed, false);
  });

  test('picks up Crawl-delay from the matching group', () => {
    assert.equal(isAllowed(controlled, USER_AGENT, '/').crawlDelaySeconds, 4);
  });

  test('the most specific user-agent wins regardless of file order', () => {
    const parsed = parseRobots(`
      User-agent: *
      Disallow: /

      User-agent: bot
      Disallow: /a/

      User-agent: jubileesearchbot
      Disallow: /b/
    `);
    assert.equal(groupFor(parsed, USER_AGENT).agents[0], 'jubileesearchbot');
    assert.equal(isAllowed(parsed, USER_AGENT, '/anything').allowed, true);
    assert.equal(isAllowed(parsed, USER_AGENT, '/b/x').allowed, false);
  });

  test('an empty Disallow is an allow-all, not a disallow of everything', () => {
    const parsed = parseRobots('User-agent: *\nDisallow:');
    assert.equal(isAllowed(parsed, USER_AGENT, '/anything').allowed, true);
  });

  test('Disallow: / blocks the whole site', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /');
    assert.equal(isAllowed(parsed, USER_AGENT, '/').allowed, false);
    assert.equal(isAllowed(parsed, USER_AGENT, '/anything/at/all').allowed, false);
  });

  test('longest match wins, and a tie goes to Allow', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/b/\nDisallow: /a/b/c/');
    assert.equal(isAllowed(parsed, USER_AGENT, '/a/x').allowed, false);
    assert.equal(isAllowed(parsed, USER_AGENT, '/a/b/x').allowed, true);
    assert.equal(isAllowed(parsed, USER_AGENT, '/a/b/c/x').allowed, false);

    const tie = parseRobots('User-agent: *\nDisallow: /x/\nAllow: /x/');
    assert.equal(isAllowed(tie, USER_AGENT, '/x/y').allowed, true);
  });

  test('wildcards and the end-anchor are honoured', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/private');
    assert.equal(isAllowed(parsed, USER_AGENT, '/docs/report.pdf').allowed, false);
    assert.equal(isAllowed(parsed, USER_AGENT, '/docs/report.pdf.html').allowed, true);
    assert.equal(isAllowed(parsed, USER_AGENT, '/a/b/private').allowed, false);
  });

  test('a comment does not become part of a rule', () => {
    const parsed = parseRobots('User-agent: *  # everyone\nDisallow: /x/  # the private bit');
    assert.equal(parsed.groups[0].rules[0].path, '/x/');
  });

  test('sitemaps are global, not part of any group', () => {
    const parsed = parseRobots('Sitemap: https://a.com/sitemap.xml\nUser-agent: *\nDisallow: /x/\nSitemap: https://a.com/news.xml');
    assert.deepEqual(parsed.sitemaps, ['https://a.com/sitemap.xml', 'https://a.com/news.xml']);
  });

  test('no rules at all means allow', () => {
    assert.equal(isAllowed(parseRobots(''), USER_AGENT, '/x').allowed, true);
  });
});

describe('robots directives on the page', () => {
  test('noindex and nofollow are read independently', () => {
    assert.deepEqual(parseRobotsDirectives('noindex'), { noindex: true, nofollow: false, noarchive: false });
    assert.deepEqual(parseRobotsDirectives('nofollow'), { noindex: false, nofollow: true, noarchive: false });
    assert.deepEqual(parseRobotsDirectives('none'), { noindex: true, nofollow: true, noarchive: false });
  });

  test('an X-Robots-Tag addressed to another bot is not ours to obey', () => {
    assert.equal(parseXRobotsTag('googlebot: noindex').noindex, false);
    assert.equal(parseXRobotsTag('jubileesearchbot: noindex').noindex, true);
    assert.equal(parseXRobotsTag('noindex').noindex, true);
  });

  test('several header values merge', () => {
    const merged = parseXRobotsTag(['noarchive', 'jubileesearchbot: nofollow']);
    assert.equal(merged.nofollow, true);
    assert.equal(merged.noarchive, true);
    assert.equal(merged.noindex, false);
  });

  test('a directive with a value is not mistaken for a bot name', () => {
    assert.equal(parseXRobotsTag('max-snippet: 20').noindex, false);
  });
});

describe('URL admission', () => {
  test('images are refused at the frontier, before any request', () => {
    // P10. The Content-Type check in the fetcher is the second line of defence,
    // not the first.
    for (const ext of ['jpg', 'png', 'gif', 'webp', 'svg', 'avif']) {
      const verdict = admit(`https://example.com/a/photo.${ext}`, T3);
      assert.equal(verdict.allowed, false, `.${ext} was admitted`);
      assert.match(verdict.reason, /extension/);
    }
  });

  test('media and binaries are refused', () => {
    for (const url of ['https://example.com/a.mp4', 'https://example.com/a.zip', 'https://example.com/a.css']) {
      assert.equal(admit(url, T3).allowed, false, url);
    }
  });

  test('documents are admitted', () => {
    for (const url of ['https://example.com/teaching/emunah',
                       'https://example.com/notes.html',
                       'https://example.com/report.pdf']) {
      assert.equal(admit(url, T3).allowed, true, url);
    }
  });

  test('off-domain links are refused, subdomains are not', () => {
    assert.equal(admit('https://other.org/x', T3).allowed, false);
    assert.equal(admit('https://blog.example.com/x', T3).allowed, true);
    assert.equal(admit('https://www.example.com/x', T3).allowed, true);
  });

  test('depth is capped per domain', () => {
    assert.equal(admit('https://example.com/x', T3, { depth: 2 }).allowed, true);
    assert.equal(admit('https://example.com/x', T3, { depth: 3 }).allowed, false);
  });

  test('crawler traps are refused', () => {
    for (const url of ['https://example.com/wp-admin/index.php',
                       'https://example.com/checkout/',
                       'https://example.com/events/2026/03/04',
                       'https://example.com/x?sessionid=abc',
                       'https://example.com/a/b/c/d/e/f/g/h/i/j']) {
      assert.equal(admit(url, T3).allowed, false, url);
    }
  });

  test('non-http schemes are refused', () => {
    assert.equal(admit('ftp://example.com/x', T3).allowed, false);
    assert.equal(admit('javascript:alert(1)', T3).allowed, false);
  });

  test('deny_patterns beat allow_patterns', () => {
    const domain = { ...T3, allow_patterns: ['/teaching/'], deny_patterns: ['/teaching/drafts/'] };
    assert.equal(admit('https://example.com/teaching/x', domain).allowed, true);
    assert.equal(admit('https://example.com/teaching/drafts/x', domain).allowed, false);
    assert.equal(admit('https://example.com/other/x', domain).allowed, false);
  });

  test('an invalid pattern in the registry does not throw', () => {
    const domain = { ...T3, deny_patterns: ['('] };
    assert.equal(admit('https://example.com/x', domain).allowed, true);
  });

  test('content types are gated, and images are named as such', () => {
    assert.equal(acceptsContentType('text/html; charset=utf-8').accepted, true);
    assert.equal(acceptsContentType('application/pdf').accepted, true);
    assert.equal(acceptsContentType('application/json').accepted, false);
    const image = acceptsContentType('image/jpeg');
    assert.equal(image.accepted, false);
    assert.match(image.reason, /P10/);
  });
});

describe('adaptive recrawl interval', () => {
  test('unchanged three times widens the interval by half', () => {
    assert.equal(nextInterval(168, 168, 2, false), 168, 'not yet');
    assert.equal(nextInterval(168, 168, 3, false), 252);
  });

  test('a change narrows it back toward the floor', () => {
    assert.equal(nextInterval(720, 168, 0, true), 360);
    assert.equal(nextInterval(168, 168, 0, true), 168, 'never below the floor');
  });

  test('the widening is capped at 30 days', () => {
    assert.equal(nextInterval(700, 168, 9, false), 720);
  });
});

describe('sitemaps', () => {
  test('parses a urlset', () => {
    const { kind, entries } = parseSitemap(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://a.com/one</loc><lastmod>2026-01-02</lastmod><priority>0.8</priority></url>
        <url><loc>https://a.com/two</loc></url>
      </urlset>`);
    assert.equal(kind, 'urlset');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].url, 'https://a.com/one');
    assert.equal(entries[0].lastmod.slice(0, 10), '2026-01-02');
    assert.equal(entries[1].lastmod, null);
  });

  test('parses a sitemap index and flags its entries', () => {
    const { kind, entries } = parseSitemap(`
      <sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`);
    assert.equal(kind, 'sitemapindex');
    assert.equal(entries[0].isIndex, true);
  });

  test('parses RSS', () => {
    const { kind, entries } = parseSitemap(`
      <rss><channel><item><title>A post</title><link>https://a.com/p</link>
      <pubDate>Tue, 03 Mar 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
    assert.equal(kind, 'feed');
    assert.equal(entries[0].url, 'https://a.com/p');
    assert.equal(entries[0].title, 'A post');
  });

  test('parses Atom, where the URL is an attribute', () => {
    const { entries } = parseSitemap(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><title>T</title><link rel="alternate" href="https://a.com/e"/>
        <updated>2026-02-01T00:00:00Z</updated></entry>
      </feed>`);
    assert.equal(entries[0].url, 'https://a.com/e');
  });

  test('an Atom self link is not mistaken for the entry', () => {
    const { entries } = parseSitemap(`
      <feed><entry><link rel="self" href="https://a.com/feed"/>
      <link rel="alternate" href="https://a.com/real"/></entry></feed>`);
    assert.equal(entries[0].url, 'https://a.com/real');
  });

  test('namespaced tags are handled', () => {
    const { entries } = parseSitemap(`
      <sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sm:url><sm:loc>https://a.com/ns</sm:loc></sm:url>
      </sm:urlset>`);
    assert.equal(entries[0].url, 'https://a.com/ns');
  });

  test('junk does not throw', () => {
    assert.deepEqual(parseSitemap('not xml at all').entries, []);
    assert.deepEqual(parseSitemap('').entries, []);
  });
});

describe('content extraction', () => {
  const page = `<!DOCTYPE html>
    <html lang="ro">
    <head>
      <title>Ce este emunah | Site</title>
      <meta name="description" content="O privire asupra credintei.">
      <meta property="og:image" content="https://cdn.example.com/hero.jpg">
      <link rel="canonical" href="https://example.com/teaching/emunah">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Article",
         "headline":"Ce este emunah","author":{"name":"Zev Inspire"},
         "datePublished":"2026-02-01","dateModified":"2026-02-10"}
      </script>
      <style>.x{color:red}</style>
    </head>
    <body>
      <nav><a href="/">Acasa</a><a href="/despre">Despre</a><a href="/contact">Contact</a></nav>
      <div class="sidebar"><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></div>
      <main>
        <h1>Ce este emunah</h1>
        <p>Emunah nu este acord. Este statornicia care continua sa mearga, chiar
           atunci cand drumul nu se vede, si aceasta este diferenta.</p>
        <h2>Radacina cuvantului</h2>
        <p>Radacina este aman, si poarta sensul de a fi ferm asezat, sprijinit,
           intemeiat pe ceva care nu se clatina sub greutate.</p>
        <ul><li>Un punct</li><li>Alt punct</li></ul>
        <p>Vezi <a href="https://jubileepedia.com/emunah">studiul</a> pentru mai mult.</p>
        <img src="/hero.jpg" alt="o imagine">
      </main>
      <footer><a href="/termeni">Termeni</a><p>Drepturi rezervate 2026.</p></footer>
      <script>console.log('tracking')</script>
    </body></html>`;

  const result = extract(page, 'https://example.com/teaching/emunah');

  test('pulls metadata from JSON-LD, meta tags and the canonical link', () => {
    assert.equal(result.title, 'Ce este emunah');
    assert.equal(result.author, 'Zev Inspire');
    assert.equal(result.canonical_url, 'https://example.com/teaching/emunah');
    assert.equal(result.description, 'O privire asupra credintei.');
    assert.equal(result.published_at.slice(0, 10), '2026-02-01');
    assert.equal(result.modified_at.slice(0, 10), '2026-02-10');
    assert.equal(result.language, 'ro');
  });

  test('strips navigation, sidebar, footer, script and style', () => {
    for (const noise of ['Acasa', 'Despre', 'Contact', 'Termeni', 'tracking', 'color:red', 'Drepturi rezervate']) {
      assert.ok(!result.body_text.includes(noise), `boilerplate survived: ${noise}`);
    }
  });

  test('keeps the article', () => {
    assert.ok(result.body_text.includes('Emunah nu este acord'));
    assert.ok(result.body_text.includes('Radacina este aman'));
    assert.ok(result.word_count > 30);
  });

  test('emits markdown so the existing chunker can split on headings', () => {
    assert.match(result.markdown, /^# Ce este emunah$/m);
    assert.match(result.markdown, /^## Radacina cuvantului$/m);
    assert.match(result.markdown, /^- Un punct$/m);
  });

  test('records the OpenGraph image URL and no other image', () => {
    // Metadata only (spec 2.2). The <img> in the body contributes nothing, and
    // its alt text is not smuggled in as content.
    assert.equal(result.og_image_url, 'https://cdn.example.com/hero.jpg');
    assert.ok(!result.body_text.includes('o imagine'));
    assert.ok(!result.markdown.includes('hero.jpg'));
  });

  test('extracts links with anchor text and internal/external split', () => {
    const external = result.links.find((l) => l.to_url.includes('jubileepedia'));
    assert.ok(external);
    assert.equal(external.anchor_text, 'studiul');
    assert.equal(external.is_internal, false);
    assert.equal(result.outlink_count, 1);
  });

  test('a semantic <main> is preferred over the scoring heuristic', () => {
    assert.match(result.extraction.strategy, /semantic/);
  });

  test('falls back to scoring when there is no <main>', () => {
    const noMain = extract(`<html><body>
      <div class="menu"><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a></div>
      <div class="post-content">
        <p>${'This is the actual article body, and it runs for a while. '.repeat(6)}</p>
        <p>${'A second paragraph of genuine prose, also long enough to count. '.repeat(6)}</p>
      </div></body></html>`, 'https://example.com/x');
    assert.equal(noMain.extraction.strategy, 'scored');
    assert.ok(noMain.body_text.includes('actual article body'));
    assert.ok(!noMain.body_text.includes('1'));
  });

  test('a future publication date is discarded rather than boosted', () => {
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const r = extract(`<html><head><meta property="article:published_time" content="${future}"></head>
      <body><main><p>${'Words enough to be a body. '.repeat(10)}</p></main></body></html>`,
      'https://example.com/x');
    assert.equal(r.published_at, null);
  });

  test('malformed HTML does not throw', () => {
    assert.doesNotThrow(() => extract('<html><body><p>unclosed <div><span>', 'https://example.com/x'));
    assert.doesNotThrow(() => extract('', 'https://example.com/x'));
  });

  test('charset comes from the header first, then the meta tag', () => {
    assert.equal(detectCharset(Buffer.from(''), 'text/html; charset=ISO-8859-2'), 'iso-8859-2');
    assert.equal(detectCharset(Buffer.from('<meta charset="windows-1250">'), 'text/html'), 'windows-1250');
    assert.equal(detectCharset(Buffer.from('<html>'), 'text/html'), 'utf-8');
  });
});

describe('near-duplicate detection', () => {
  const article = `${'The appointed times are a shadow of what is to come, and the body is of Messiah. '.repeat(12)}`;

  test('identical text hashes identically', () => {
    assert.equal(simhash(article), simhash(article));
  });

  test('a syndicated copy with a different footer stays within the threshold', () => {
    const syndicated = `${article}\n\nOriginally published on another Jubilee property. Reprinted with permission.`;
    const distance = hammingDistance(simhash(article), simhash(syndicated));
    assert.ok(distance <= 3, `distance was ${distance}, past the near-duplicate threshold`);
  });

  test('a different article on the same theme is not a duplicate', () => {
    const other = `${'Teshuvah is a turning and a returning, and it is never finished in one sitting. '.repeat(12)}`;
    const distance = hammingDistance(simhash(article), simhash(other));
    assert.ok(distance > 3, `distance was only ${distance}; unrelated articles should not collide`);
  });

  test('the four bands cover every hash within distance 3', () => {
    // The pigeonhole argument migration 013 relies on: at most 3 differing bits
    // across 4 bands means at least one band matches exactly.
    const base = simhash(article);
    for (let trial = 0; trial < 200; trial++) {
      let mutated = base;
      const flips = 1 + (trial % 3);
      for (let i = 0; i < flips; i++) {
        mutated ^= 1n << BigInt((trial * 7 + i * 17) % 64);
      }
      const shared = bands(base).some((b, i) => b === bands(mutated)[i]);
      assert.ok(shared, `no band matched after ${flips} bit flips`);
    }
  });

  test('the signed round trip preserves the bit pattern', () => {
    for (const value of [0n, 1n, (1n << 63n), (1n << 64n) - 1n, simhash(article)]) {
      assert.equal(fromSigned(toSigned(value)), value);
    }
    assert.ok(toSigned(1n << 63n) < 0n, 'the high bit must come out negative for BIGINT');
  });

  test('canonical preference: canonical_url, then T1, then oldest', () => {
    const oldest = { id: 3, url: 'https://c.com/x', tier: 'T3', first_seen_at: '2020-01-01' };
    const t1 = { id: 2, url: 'https://b.com/x', tier: 'T1', first_seen_at: '2026-01-01' };
    const selfCanonical = { id: 1, url: 'https://a.com/x', canonical_url: 'https://a.com/x', tier: 'T3', first_seen_at: '2026-06-01' };

    assert.equal(pickCanonical([oldest, t1, selfCanonical]).id, 1);
    assert.equal(pickCanonical([oldest, t1]).id, 2, 'T1 beats an older T3');
    assert.equal(pickCanonical([oldest, { ...t1, tier: 'T3' }]).id, 3, 'then oldest');
  });

  test('empty text hashes to zero rather than throwing', () => {
    assert.equal(simhash(''), 0n);
  });
});

describe('PDF text layer', () => {
  test('rejects something that is not a PDF', () => {
    assert.deepEqual(extractPdfText(Buffer.from('hello')), { text: '', ok: false, reason: 'not_a_pdf' });
  });

  test('reports an encrypted document as such', () => {
    const buf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('/Encrypt 1 0 R')]);
    assert.equal(extractPdfText(buf).reason, 'encrypted');
  });

  test('reads an uncompressed text stream', () => {
    const content = 'BT /F1 12 Tf (The appointed times are a shadow of what is to come, and the body) Tj T* '
                  + '(is of Messiah, who is the substance and the fulfilment of them all.) Tj ET';
    const buf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    const result = extractPdfText(buf);
    assert.ok(result.text.includes('appointed times'), result.text);
    assert.ok(result.text.includes('substance'));
  });

  test('a scan with no text layer is rejected, not indexed empty', () => {
    const buf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n');
    assert.equal(extractPdfText(buf).reason, 'no_text_layer');
  });

  test('looksLikeText rejects a font-encoding failure', () => {
    // The failure mode that matters: text extracted through the wrong encoding
    // is not empty, it is bytes, and bytes tokenise into terms that match
    // nothing and pollute the tsvector.
    const glyphIndices = Array.from({ length: 400 }, (_, i) => String.fromCharCode(1 + (i % 26))).join('');
    assert.equal(looksLikeText(glyphIndices), false);
    assert.equal(looksLikeText(''.repeat(200)), false);
  });

  test('looksLikeText accepts real prose', () => {
    assert.equal(looksLikeText('The appointed times are a shadow of what is to come, '
      + 'and the body is of Messiah. This is a sentence with ordinary words in it.'), true);
  });

  test('looksLikeText rejects a run with no spaces', () => {
    assert.equal(looksLikeText('theappointedtimesareashadowofwhatistocomeandthebodyisofmessiah'.repeat(3)), false);
  });
});

describe('backoff', () => {
  test('grows with the attempt and stays inside the cap', () => {
    const first = backoffMs(1);
    const later = backoffMs(6);
    assert.ok(first >= 1000 && first <= 3000);
    assert.ok(later > first);
    assert.ok(backoffMs(20) <= 10 * 60_000);
  });

  test('Retry-After is honoured over the exponent', () => {
    assert.equal(backoffMs(1, 30_000), 30_000);
    assert.equal(backoffMs(1, 60 * 60_000), 15 * 60_000, 'but capped');
  });

  test('is jittered, so a queue of URLs does not retry in lockstep', () => {
    const samples = new Set(Array.from({ length: 20 }, () => backoffMs(4)));
    assert.ok(samples.size > 10, 'backoff looks deterministic');
  });
});
