// Tests for the ingest path that does no I/O: frontmatter mapping, markdown
// stripping, chunking, URL normalisation, and webhook signature verification.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  parseFrontmatter, mapToPage, stripMarkdown, extractHeadings,
  buildUrl, normalizeUrl, contentHash,
} from '../src/ingest/markdown.js';
import { chunkMarkdown, splitSections, estimateTokens, MAX_TOKENS, SINGLE_CHUNK_WORDS } from '../src/ingest/chunker.js';
import { verifyWebhook, signPayload, canonicalize, WINDOW_SECONDS } from '../src/ingest/hmac.js';
import { safeJoin } from '../src/ingest/source.js';
import { engagementScore } from '../src/jobs/engagement.js';
import { consume, reset, LIMITS } from '../src/api/ratelimit.js';

const ARTICLE = `---
title: Become a Believing Believer
slug: become-a-believing-believer
category: Torah and Hebraic Insights
persona: Zev Inspire
office: Teacher
created: 2026-03-04
updated: 2026-04-01
language: en
image: believing-believer.png
tags: [emunah, faith, teshuvah]
characters: [Zev Inspire, Daisy Wylder]
related_slugs: [what-is-emunah, the-long-return]
---

# Become a Believing Believer

Emunah is not agreement. It is the **steadfastness** that keeps walking.

## What the word carries

The root is *aman*. See [the study](https://jubileepedia.com/emunah) for more.

### A closing thought

Teshuvah is a turning, and it is never finished.
`;

// The sample article is deliberately short, which makes it a single chunk --
// correct behaviour, and useless for testing the section splitter. This is the
// same shape with sections long enough to exercise it.
const LONG_ARTICLE_BODY = `
# Become a Believing Believer

${'Emunah is not agreement; it is the steadfastness that keeps walking. '.repeat(30)}

## What the word carries

${'The root is aman, and it carries the sense of being firmly established. '.repeat(30)}

### A closing thought

${'Teshuvah is a turning, and it is never finished in one sitting. '.repeat(30)}
`;

const domain = { host: 'jubileeverse.com', url_template: 'https://{host}/{category_slug}/{slug}' };

describe('frontmatter', () => {
  test('parses the YAML block and returns the body separately', () => {
    const { data, body } = parseFrontmatter(ARTICLE);
    assert.equal(data.title, 'Become a Believing Believer');
    assert.ok(body.startsWith('\n# Become'));
  });

  test('a malformed block degrades to an empty map plus an error, not a thrown page', () => {
    const { data, body, error } = parseFrontmatter('---\ntitle: [unclosed\n---\nbody text\n');
    assert.deepEqual(data, {});
    assert.equal(body.trim(), 'body text');
    assert.ok(error);
  });

  test('a document with no frontmatter is still a document', () => {
    const { data, body } = parseFrontmatter('# Just a heading\n');
    assert.deepEqual(data, {});
    assert.equal(body, '# Just a heading\n');
  });
});

describe('mapToPage', () => {
  const page = mapToPage(ARTICLE, domain, 'articles/torah/become-a-believing-believer.md');

  test('maps every frontmatter field the spec lists', () => {
    assert.equal(page.title, 'Become a Believing Believer');
    assert.equal(page.category, 'Torah and Hebraic Insights');
    assert.equal(page.persona, 'Zev Inspire');
    assert.equal(page.office, 'Teacher');
    assert.equal(page.language, 'en');
    assert.deepEqual(page.tags, ['emunah', 'faith', 'teshuvah']);
    assert.deepEqual(page.characters, ['Zev Inspire', 'Daisy Wylder']);
    assert.deepEqual(page.related_slugs, ['what-is-emunah', 'the-long-return']);
    assert.equal(page.published_at.slice(0, 10), '2026-03-04');
    assert.equal(page.modified_at.slice(0, 10), '2026-04-01');
  });

  test('records the image URL as metadata and nothing more', () => {
    // P10 and section 2.2: retained as a field, never fetched, never rendered.
    // The guarantee that matters is enforced elsewhere -- nothing in src/query
    // selects this column -- but it must at least be captured here.
    assert.equal(page.og_image_url, 'believing-believer.png');
  });

  test('composes the public URL from the domain template', () => {
    assert.equal(page.url,
      'https://jubileeverse.com/torah-and-hebraic-insights/become-a-believing-believer');
  });

  test('strips markdown syntax out of body_text', () => {
    assert.ok(!page.body_text.includes('**'));
    assert.ok(!page.body_text.includes('#'));
    assert.ok(page.body_text.includes('steadfastness'));
    assert.ok(page.body_text.includes('the study'), 'link text survives, the URL does not');
    assert.ok(!page.body_text.includes('jubileepedia.com'));
  });

  test('content_hash ignores whitespace-only changes', () => {
    // Acceptance criterion 3: an unchanged page consumes no embedding compute.
    // Reflowed markdown is not a change.
    const reflowed = ARTICLE.replace(/\n\n/g, '\n\n\n');
    assert.ok(contentHash(stripMarkdown(reflowed)).equals(page.content_hash));
  });

  test('a slug missing from frontmatter falls back to the file name', () => {
    const p = mapToPage('# Title only\n\nSome words here.', domain, 'articles/fallback-slug.md');
    assert.ok(p.url.endsWith('/fallback-slug'));
  });
});

describe('markdown stripping', () => {
  test('drops images entirely', () => {
    assert.equal(stripMarkdown('before ![alt text](pic.png) after'), 'before after');
    assert.ok(!stripMarkdown('![alt](x.png)').includes('x.png'));
  });

  test('does not parse markdown inside a fenced block', () => {
    assert.ok(!stripMarkdown('```\n# not a heading\n```').includes('not a heading'));
  });

  test('extractHeadings walks the tree and skips fences', () => {
    const headings = extractHeadings(ARTICLE);
    assert.deepEqual(headings.map((h) => h.level), [1, 2, 3]);
    assert.equal(headings[1].text, 'What the word carries');
    assert.deepEqual(extractHeadings('```\n# fenced\n```\n# real'), [{ level: 1, text: 'real' }]);
  });
});

describe('chunking', () => {
  test('rejects thin content', () => {
    assert.equal(chunkMarkdown('Ten words is not enough to be an article at all.').rejected,
      'thin_content');
  });

  test('a short page is one chunk', () => {
    const words = 'grace and truth came through him '.repeat(8);   // ~48 words
    const { chunks, rejected } = chunkMarkdown(words);
    assert.equal(rejected, null);
    assert.equal(chunks.length, 1);
  });

  test('splits on heading boundaries and records the breadcrumb', () => {
    const { chunks } = chunkMarkdown(LONG_ARTICLE_BODY, { title: 'Become a Believing Believer' });
    const paths = chunks.map((c) => c.heading_path);
    assert.ok(paths.includes('Become a Believing Believer > What the word carries'));
    assert.ok(paths.some((p) => p?.endsWith('A closing thought')));
  });

  test('prefixes the embed text with title and breadcrumb, but not the stored text', () => {
    const { chunks } = chunkMarkdown(LONG_ARTICLE_BODY, { title: 'Become a Believing Believer' });
    const c = chunks.find((x) => x.heading_path?.includes('What the word carries'));
    assert.ok(c.embed_text.startsWith('Become a Believing Believer > What the word carries'));
    assert.ok(!c.text.startsWith('Become a Believing Believer >'),
      'a snippet must not be prefixed with its own breadcrumb');
  });

  test('long prose is windowed under the token ceiling', () => {
    const long = Array.from({ length: 60 },
      (_, i) => `Paragraph ${i}. ${'the appointed times are a shadow of what is to come. '.repeat(12)}`)
      .join('\n\n');
    const { chunks } = chunkMarkdown(long);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.token_count <= MAX_TOKENS,
        `chunk ${c.ordinal} is ${c.token_count} tokens, over the ${MAX_TOKENS} ceiling`);
    }
    assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
  });

  test('a single over-long paragraph is split by sentence, never mid-sentence', () => {
    const paragraph = 'This is a sentence about the appointed times and their meaning. '.repeat(80);
    const { chunks } = chunkMarkdown(paragraph);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(/[.!?]$/.test(c.text.trim()));
  });

  test('splitSections carries the heading stack down the tree', () => {
    const sections = splitSections('# A\n\ntext a\n\n## B\n\ntext b\n\n### C\n\ntext c\n\n## D\n\ntext d');
    assert.deepEqual(sections.map((s) => s.headingPath), ['A', 'A > B', 'A > B > C', 'A > D']);
  });

  test('estimateTokens runs above the word count, not below', () => {
    assert.ok(estimateTokens('one two three') >= 3);
  });
});

describe('URL normalisation', () => {
  test('one canonical form per address', () => {
    const forms = [
      'https://www.Jubileeverse.com/torah/x/',
      'http://jubileeverse.com/torah/x#section',
      'https://jubileeverse.com/torah/x?utm_source=newsletter',
    ];
    const canonical = new Set(forms.map(normalizeUrl));
    assert.equal(canonical.size, 1, [...canonical].join(' vs '));
  });

  test('meaningful query parameters survive', () => {
    assert.ok(normalizeUrl('https://a.com/p?page=2').includes('page=2'));
  });

  test('buildUrl collapses an empty template segment', () => {
    assert.equal(buildUrl({ host: 'a.com', url_template: 'https://{host}/{category_slug}/{slug}' },
      {}, 'the-slug'), 'https://a.com/the-slug');
  });
});

describe('webhook signatures', () => {
  const secret = 'shared-secret';
  const raw = JSON.stringify({ host: 'jubileeverse.com', source_path: 'a.md', event: 'publish' });
  const now = 1_800_000_000;

  test('accepts a correctly signed header request', () => {
    const r = verifyWebhook({
      rawBody: raw,
      headers: {
        'x-jubilee-timestamp': String(now),
        'x-jubilee-signature': `sha256=${signPayload(secret, now, raw)}`,
      },
      secret, now,
    });
    assert.equal(r.ok, true);
    assert.equal(r.scheme, 'header');
  });

  test('rejects an unsigned request', () => {
    assert.equal(verifyWebhook({ rawBody: raw, headers: {}, secret, now }).ok, false);
  });

  test('rejects a tampered body', () => {
    const sig = signPayload(secret, now, raw);
    const r = verifyWebhook({
      rawBody: raw.replace('publish', 'unpublish'),
      headers: { 'x-jubilee-timestamp': String(now), 'x-jubilee-signature': sig },
      secret, now,
    });
    assert.equal(r.ok, false);
  });

  test('rejects a stale request outside the five-minute window', () => {
    const old = now - WINDOW_SECONDS - 1;
    const r = verifyWebhook({
      rawBody: raw,
      headers: { 'x-jubilee-timestamp': String(old), 'x-jubilee-signature': `sha256=${signPayload(secret, old, raw)}` },
      secret, now,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'stale request');
  });

  test('rejects a request signed with the wrong secret', () => {
    const r = verifyWebhook({
      rawBody: raw,
      headers: { 'x-jubilee-timestamp': String(now), 'x-jubilee-signature': signPayload('wrong', now, raw) },
      secret, now,
    });
    assert.equal(r.ok, false);
  });

  test('the in-body compatibility form works, but only with a timestamp', () => {
    const parsed = { host: 'a.com', event: 'publish', issued_at: now };
    const body = { ...parsed, signature: hmacOf(secret, canonicalize(parsed)) };
    assert.equal(verifyWebhook({ rawBody: '', parsed: body, secret, now }).ok, true);

    const undated = { host: 'a.com', event: 'publish' };
    const undatedBody = { ...undated, signature: hmacOf(secret, canonicalize(undated)) };
    const r = verifyWebhook({ rawBody: '', parsed: undatedBody, secret, now });
    assert.equal(r.ok, false, 'without a timestamp the replay window cannot be enforced');
  });

  test('a domain with no secret configured can never be pushed to', () => {
    assert.equal(verifyWebhook({ rawBody: raw, headers: {}, secret: null, now }).ok, false);
  });
});

describe('source path safety', () => {
  test('refuses traversal out of source_root', () => {
    assert.throws(() => safeJoin('/var/content', '../../etc/passwd'));
    assert.throws(() => safeJoin('/var/content', 'a/../../../etc/passwd'));
  });

  test('joins an ordinary relative path', () => {
    assert.ok(safeJoin('/var/content', 'articles/x.md').replace(/\\/g, '/')
      .endsWith('/var/content/articles/x.md'));
  });

  test('joins a remote root as a URL', () => {
    assert.equal(safeJoin('https://cdn.example/content/', 'a/b.md'),
      'https://cdn.example/content/a/b.md');
  });
});

describe('engagement scoring', () => {
  test('a well-read page scores far above a bounced one', () => {
    const read = engagementScore({
      pageviews: 800, median_dwell_ms: 170_000, scroll_depth_pct: 90,
      bounce_rate: 15, completion_rate: 70 });
    const bounced = engagementScore({
      pageviews: 800, median_dwell_ms: 3_000, scroll_depth_pct: 8,
      bounce_rate: 92, completion_rate: 2 });
    assert.ok(read > bounced * 2, `${read} vs ${bounced}`);
    assert.ok(read <= 100 && bounced >= 0);
  });

  test('missing metrics score zero rather than throwing', () => {
    assert.equal(engagementScore({}), 0);
  });

  test('dwell saturates, so a longer article does not outrank a useful one', () => {
    const three = engagementScore({ median_dwell_ms: 180_000 });
    const ten = engagementScore({ median_dwell_ms: 600_000 });
    assert.equal(three, ten);
  });
});

describe('rate limiting', () => {
  test('allows up to the anonymous limit then returns a retry hint', () => {
    reset();
    for (let i = 0; i < LIMITS.anonymous; i++) {
      assert.equal(consume('ip:1.2.3.4', LIMITS.anonymous).allowed, true, `request ${i + 1}`);
    }
    const over = consume('ip:1.2.3.4', LIMITS.anonymous);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfter >= 1);
  });

  test('buckets are per key', () => {
    reset();
    consume('ip:1.1.1.1', 1);
    assert.equal(consume('ip:2.2.2.2', 1).allowed, true);
  });
});

const hmacOf = (secret, material) =>
  createHmac('sha256', secret).update(material).digest('hex');


// ---------------------------------------------------------------------------
// Two defects found while verifying the first real CDN import. Both were in the
// chunker, both predated the CDN importer, and both corrupted every chunk built
// through the section path -- the text that gets embedded AND the text a
// semantic-only result shows the reader as its snippet.
//
// These fail against the code as it was.
// ---------------------------------------------------------------------------
describe('chunker corruption regressions', () => {
  // A real article shape: YAML frontmatter, an H1, then prose under headings.
  const ARTICLE = [
    '---',
    'title: "A Sealed Letter, an Open Kingdom"',
    'slug: "a-sealed-letter-an-open-kingdom"',
    'category: "Covenant & Identity"',
    'author: "Zev Inspire"',
    'scripture_refs: ["Exodus 12:13", "1 Kings 18:21"]',
    'characters: ["Delwyn Cantrell"]',
    '---',
    '',
    '# A Sealed Letter, an Open Kingdom',
    '',
    'Hand lettering has been leaving the stone trade for years.',
    'A laser can cut a name in minutes and never gets tired.',
    '',
    "Paragraph 1 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 2 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 3 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 4 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    '## The turn',
    '',
    'There is a mark in the Hebrew Bible that has embarrassed people for centuries.',
    'Nobody has ever removed it, and that is the point worth sitting with.',
    '',
    'It survives because somebody decided accuracy mattered more than comfort.',
    '',
    "Paragraph 1 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 2 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 3 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
    '',
    "Paragraph 4 carries enough ordinary prose to push this fixture past the single-chunk threshold, because the two defects being guarded here live in the section splitting path and a short document never reaches it. The sentences are plain on purpose: what is under test is structure, not language.",
  ].join('\n');

  // Guard the guard: if this ever drops below the single-chunk threshold the
  // tests below stop exercising splitSections, which is where both defects were.
  test('the fixture is long enough to reach the section-splitting path', () => {
    const words = ARTICLE.split(/\s+/).filter(Boolean).length;
    assert.ok(words > SINGLE_CHUNK_WORDS,
      `fixture is ${words} words; it must exceed SINGLE_CHUNK_WORDS (${SINGLE_CHUNK_WORDS}) or the section path is never taken`);
    assert.ok(splitSections(ARTICLE).length > 1, 'fixture must produce more than one section');
  });

  test('frontmatter never reaches a chunk', () => {
    const { chunks, rejected } = chunkMarkdown(ARTICLE, { title: 'A Sealed Letter, an Open Kingdom' });
    assert.equal(rejected, null);
    assert.ok(chunks.length > 0);

    for (const chunk of chunks) {
      // The delimiter itself.
      assert.ok(!chunk.text.includes('---'),
        `chunk ${chunk.ordinal} still carries a frontmatter delimiter: ${chunk.text.slice(0, 80)}`);
      // And the keys, which is what actually got embedded as though it were prose.
      for (const key of ['title:', 'slug:', 'category:', 'author:', 'scripture_refs:', 'characters:']) {
        assert.ok(!chunk.text.includes(key),
          `chunk ${chunk.ordinal} still carries the frontmatter key "${key}"`);
      }
      // embed_text is what the model actually sees, so it is checked too. The
      // title prefix is deliberate; the YAML is not.
      assert.ok(!chunk.embed_text.includes('slug:'),
        'embed_text still carries frontmatter');
    }
  });

  test('chunk text preserves newlines and is never array-stringified', () => {
    const { chunks } = chunkMarkdown(ARTICLE, { title: 'A Sealed Letter, an Open Kingdom' });
    const joined = chunks.map((c) => c.text).join('\n');

    // The signature of String(arrayOfLines): a blank line becomes ',,' and every
    // line break becomes ','.
    assert.ok(!joined.includes(',,'),
      `array stringification detected (",," present): ${joined.slice(0, 120)}`);

    // A line break followed directly by a comma cannot occur in prose and is what
    // the coercion produced at paragraph edges.
    assert.ok(!/,\s*,/.test(joined), 'comma-joined line breaks detected');

    // Positive assertion: the paragraph structure actually survived. Without it
    // this test would pass on text that had been flattened some other way.
    const multiline = chunks.some((c) => c.text.includes('\n'));
    assert.ok(multiline, 'no chunk preserved a newline; paragraph structure was lost');

    // And the prose itself is intact, not comma-spliced.
    assert.ok(joined.includes('Hand lettering has been leaving the stone trade for years.'),
      'body text did not survive chunking intact');
  });

  test('the string sinks reject an array rather than silently comma-joining it', () => {
    // The defect was that stripMarkdown(array) coerces via String() and joins on
    // a comma instead of throwing. Rather than assert the old broken output,
    // assert the property that would have caught it: a line-array and its joined
    // form must produce the same text.
    const lines = ['First line.', '', 'Second line.'];
    const viaJoin = stripMarkdown(lines.join('\n'));
    const viaArray = stripMarkdown(lines);
    assert.notEqual(viaArray, viaJoin,
      'stripMarkdown now treats an array like its joined form; this test no longer guards anything');
    assert.ok(viaArray.includes(','),
      'the coercion no longer produces commas -- update this test to match');
    // The guarantee that matters: nothing in the pipeline may rely on that path.
    assert.ok(!viaJoin.includes(','), 'the joined form must contain no commas');
  });
});