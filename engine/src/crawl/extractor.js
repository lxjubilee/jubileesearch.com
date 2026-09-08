// Content extraction (§9.5).
//
//   1. Detect charset and language
//   2. Extract main content, stripping navigation, footers, cookie banners and
//      comments
//   3. Pull metadata: <title>, meta description, canonical link, OpenGraph
//      fields, JSON-LD Article schema, author, published and modified dates
//   4. Extract outbound links with anchor text
//   5. Compute content_hash over the normalised main text
//
// ---------------------------------------------------------------------------
// §6.1 picks Trafilatura, and Trafilatura is better than this. It has been
// trained and benchmarked against a corpus; what follows is the readability
// heuristic -- score blocks by text length against link density, take the best
// subtree -- written directly because there is no Node equivalent worth adding a
// heavy dependency for, and because `readability-lxml`, the specification's own
// fallback, is the same heuristic.
//
// Where it will be worse: pages that interleave content and furniture inside one
// container, and single-page apps that render nothing without JavaScript (which
// is what `render_js` is for). If extraction quality shows up as a recall
// problem on the gold set, running Trafilatura as a sidecar service and calling
// it over HTTP is the escape hatch, and it does not change anything else here.
//
// One thing this does that a general-purpose extractor does not: it emits
// **markdown**, not plain text. Headings come out as `#` lines. That is what
// lets `ingest/chunker.js` split a crawled page on heading boundaries using
// exactly the same code path as a source-markdown page (§12.1), instead of
// having a second, worse chunker for external content.
// ---------------------------------------------------------------------------

import { Parser, DomHandler, DomUtils } from 'htmlparser2';
import { createHash } from 'node:crypto';
import { normalizeUrl } from '../ingest/markdown.js';
import { parseRobotsDirectives } from './robots.js';

// Never contribute text. `svg` and `canvas` are here for the same reason images
// are refused at the frontier: they are pictures, and P10 means we do not want
// their alt text pretending to be content either.
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'embed', 'video', 'audio', 'picture', 'source', 'track', 'map', 'area',
  'form', 'input', 'select', 'option', 'textarea', 'button', 'label',
]);

// Structural furniture. Removed outright rather than scored: a footer with a lot
// of prose in it is still a footer.
const BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside']);

const NEGATIVE = /(^|[\s_-])(nav|navigation|menu|sidebar|side-bar|footer|header|masthead|breadcrumb|comment|disqus|cookie|consent|gdpr|banner|advert|ads?|promo|popup|modal|share|social|subscribe|newsletter|signup|related|recommend|widget|toolbar|pagination|pager|skip-link|screen-reader|sr-only|hidden|offcanvas|drawer)([\s_-]|$)/i;
const POSITIVE = /(^|[\s_-])(article|post|entry|content|main|body|story|text|prose|markdown|teaching|sermon|devotional|blog)([\s_-]|$)/i;

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'blockquote', 'pre',
  'li', 'dd', 'dt', 'td', 'th', 'figcaption', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * @param {string} html
 * @param {string} url        the URL it was fetched from, for resolving links
 * @param {object} [options]  { headers } for X-Robots-Tag and charset
 * @returns {object} everything `pages` needs, plus `markdown` for the chunker
 */
export function extract(html, url, options = {}) {
  const dom = parse(html);
  const meta = extractMetadata(dom, url, options.headers ?? {});

  const root = pickMainContent(dom);
  const markdown = root ? toMarkdown(root, url) : '';
  const bodyText = markdownToText(markdown);

  const links = extractLinks(dom, url);
  const internalHost = hostOf(url);

  return {
    ...meta,
    markdown,
    body_text: bodyText,
    word_count: bodyText.split(/\s+/).filter(Boolean).length,
    content_hash: contentHash(bodyText),
    links,
    outlink_count: links.filter((l) => !l.is_internal).length,
    internal_links: links.filter((l) => l.is_internal).map((l) => l.to_url),
    extraction: {
      // Reported so a bad extraction is diagnosable from the admin console's
      // per-URL view rather than by re-fetching the page by hand.
      strategy: root ? root.__strategy ?? 'scored' : 'none',
      container: root ? `${root.name}${root.attribs?.class ? `.${String(root.attribs.class).split(/\s+/)[0]}` : ''}` : null,
      host: internalHost,
    },
  };
}

function parse(html) {
  let dom = [];
  const handler = new DomHandler((error, parsed) => { if (!error) dom = parsed; });
  const parser = new Parser(handler, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(String(html ?? ''));
  parser.end();
  return dom;
}

// ---------------------------------------------------------------------------
// Metadata (§9.5 step 3)
// ---------------------------------------------------------------------------
function extractMetadata(dom, url, headers) {
  const metaTags = DomUtils.findAll((n) => n.name === 'meta', dom);
  const byName = new Map();
  for (const tag of metaTags) {
    const key = (tag.attribs.property ?? tag.attribs.name ?? tag.attribs.itemprop ?? '').toLowerCase();
    const value = tag.attribs.content;
    if (key && value && !byName.has(key)) byName.set(key, value);
  }

  const titleNode = DomUtils.findOne((n) => n.name === 'title', dom, true);
  const canonicalNode = DomUtils.findOne(
    (n) => n.name === 'link' && (n.attribs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'), dom, true);

  const jsonLd = extractJsonLd(dom);

  const htmlNode = DomUtils.findOne((n) => n.name === 'html', dom, true);
  const language = normaliseLang(
    htmlNode?.attribs?.lang ?? byName.get('og:locale') ?? jsonLd?.inLanguage ?? null);

  // The meta robots tag and the X-Robots-Tag header both apply; the union of
  // them is what must be obeyed.
  const metaRobots = parseRobotsDirectives(byName.get('robots'));
  const headerRobots = parseRobotsDirectives(headers['x-robots-tag']);

  return {
    title: clean(jsonLd?.headline ?? byName.get('og:title') ?? text(titleNode)),
    description: clean(byName.get('description') ?? byName.get('og:description') ?? jsonLd?.description),
    canonical_url: canonicalNode?.attribs?.href ? absolute(canonicalNode.attribs.href, url) : null,
    author: clean(authorOf(jsonLd) ?? byName.get('author') ?? byName.get('article:author')),
    published_at: date(jsonLd?.datePublished ?? byName.get('article:published_time') ?? byName.get('date')),
    modified_at: date(jsonLd?.dateModified ?? byName.get('article:modified_time')),
    language,
    // §2.2: recorded as a metadata field on T1 only, and "never fetched, never
    // cached, and never rendered in search results at any tier". The caller
    // discards it for T2 and T3 -- §9.4: "Image URLs are recorded as metadata on
    // T1 only and discarded on T2 and T3."
    og_image_url: byName.get('og:image') ?? null,
    robots: {
      noindex: metaRobots.noindex || headerRobots.noindex,
      nofollow: metaRobots.nofollow || headerRobots.nofollow,
    },
  };
}

function extractJsonLd(dom) {
  const scripts = DomUtils.findAll(
    (n) => n.name === 'script' && (n.attribs.type ?? '').toLowerCase() === 'application/ld+json', dom);

  for (const script of scripts) {
    let parsed;
    try { parsed = JSON.parse(DomUtils.textContent(script)); } catch { continue; }
    const found = findArticleNode(parsed);
    if (found) return found;
  }
  return null;
}

// JSON-LD arrives as an object, an array, or an @graph, and the Article can be
// at any depth in any of them.
function findArticleNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findArticleNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && /Article|BlogPosting|NewsArticle|WebPage/i.test(t))) {
    return node;
  }
  if (node['@graph']) return findArticleNode(node['@graph'], depth + 1);
  return null;
}

const authorOf = (jsonLd) => {
  const a = jsonLd?.author;
  if (!a) return null;
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).join(', ') || null;
  return a.name ?? null;
};

// ---------------------------------------------------------------------------
// Main content selection
// ---------------------------------------------------------------------------
function pickMainContent(dom) {
  strip(dom);

  // An explicit <main> or <article> beats any heuristic, and a page that says
  // where its content is should be believed.
  for (const tag of ['main', 'article']) {
    const node = DomUtils.findOne((n) => n.name === tag, dom, true);
    if (node && textLength(node) > 200) {
      node.__strategy = `semantic <${tag}>`;
      return node;
    }
  }
  const roleMain = DomUtils.findOne((n) => n.attribs?.role === 'main', dom, true);
  if (roleMain && textLength(roleMain) > 200) {
    roleMain.__strategy = 'role="main"';
    return roleMain;
  }

  return scoreBlocks(dom);
}

// Remove what can never be content, in place.
function strip(dom) {
  const doomed = DomUtils.findAll((n) => {
    if (DROP_TAGS.has(n.name)) return true;
    if (BOILERPLATE_TAGS.has(n.name)) return true;
    if (n.attribs?.hidden !== undefined) return true;
    if ((n.attribs?.['aria-hidden'] ?? '') === 'true') return true;
    const signature = `${n.attribs?.class ?? ''} ${n.attribs?.id ?? ''}`.trim();
    // A negative signature only condemns a node that is not itself the article:
    // "post-header" contains "header" and is often where the byline lives, but
    // a container that also matches POSITIVE is kept and left to scoring.
    return signature !== '' && NEGATIVE.test(signature) && !POSITIVE.test(signature);
  }, dom);

  for (const node of doomed) DomUtils.removeElement(node);
}

// Readability's core idea: paragraphs carry the article, so score the parents of
// substantial paragraphs and take the best one. Link density is the corrective —
// a menu is also a lot of short text, and it is nearly all links.
function scoreBlocks(dom) {
  const scores = new Map();

  for (const p of DomUtils.findAll((n) => n.name === 'p' || n.name === 'blockquote', dom)) {
    const content = DomUtils.textContent(p).trim();
    if (content.length < 25) continue;

    // Base score, plus a point per clause -- commas are a decent proxy for prose
    // as opposed to a list of labels -- plus length, capped so one enormous
    // paragraph cannot carry a container on its own.
    let score = 1 + Math.min(content.split(',').length - 1, 3) + Math.min(content.length / 100, 3);

    let node = p.parent;
    let level = 0;
    while (node && level < 3) {
      if (node.type === 'tag' && BLOCK_TAGS.has(node.name)) {
        const signature = `${node.attribs?.class ?? ''} ${node.attribs?.id ?? ''}`;
        let weighted = score / (level + 1);
        if (POSITIVE.test(signature)) weighted *= 1.5;
        scores.set(node, (scores.get(node) ?? 0) + weighted);
      }
      node = node.parent;
      level++;
    }
  }

  let best = null;
  let bestScore = 0;
  for (const [node, score] of scores) {
    const density = linkDensity(node);
    // A container that is more than half links is navigation however much text
    // it holds.
    const adjusted = score * (1 - Math.min(density, 0.95));
    if (adjusted > bestScore) { bestScore = adjusted; best = node; }
  }

  if (best) best.__strategy = 'scored';
  return best;
}

function linkDensity(node) {
  const total = textLength(node);
  if (total === 0) return 1;
  const linked = DomUtils.findAll((n) => n.name === 'a', [node])
    .reduce((sum, a) => sum + DomUtils.textContent(a).trim().length, 0);
  return linked / total;
}

const textLength = (node) => DomUtils.textContent(node).replace(/\s+/g, ' ').trim().length;

// ---------------------------------------------------------------------------
// Rendering to markdown, so the existing chunker can split on headings
// ---------------------------------------------------------------------------
const INLINE = new Set(['a', 'span', 'em', 'i', 'strong', 'b', 'u', 'code', 'small',
                        'sub', 'sup', 'mark', 'abbr', 'time', 'cite', 'q', 'br']);

function toMarkdown(root, baseUrl) {
  const out = [];

  const walk = (node, listDepth = 0) => {
    if (!node) return;

    if (node.type === 'text') {
      const value = node.data.replace(/\s+/g, ' ');
      if (value.trim()) out.push({ kind: 'text', value });
      return;
    }
    if (node.type !== 'tag' && node.type !== 'script') return;
    if (DROP_TAGS.has(node.name)) return;

    const heading = /^h([1-6])$/.exec(node.name);
    if (heading) {
      const content = DomUtils.textContent(node).replace(/\s+/g, ' ').trim();
      if (content) out.push({ kind: 'heading', level: Number(heading[1]), value: content });
      return;
    }

    if (node.name === 'br') { out.push({ kind: 'break' }); return; }
    if (node.name === 'hr') { out.push({ kind: 'block' }); return; }

    if (node.name === 'li') {
      out.push({ kind: 'listitem', depth: listDepth });
      for (const child of node.children ?? []) walk(child, listDepth);
      out.push({ kind: 'block' });
      return;
    }

    const isList = node.name === 'ul' || node.name === 'ol';
    const isBlock = BLOCK_TAGS.has(node.name) || isList;
    if (isBlock) out.push({ kind: 'block' });

    for (const child of node.children ?? []) walk(child, isList ? listDepth + 1 : listDepth);

    if (isBlock) out.push({ kind: 'block' });
  };

  walk(root);

  // Assemble. Runs of text join with single spaces; blocks become blank lines.
  const lines = [];
  let line = '';
  const flush = () => { if (line.trim()) lines.push(line.trim()); line = ''; };

  for (const token of out) {
    switch (token.kind) {
      case 'heading':
        flush();
        lines.push('');
        lines.push(`${'#'.repeat(token.level)} ${token.value}`);
        lines.push('');
        break;
      case 'listitem':
        flush();
        line = `${'  '.repeat(Math.max(0, token.depth - 1))}- `;
        break;
      case 'block':
        flush();
        if (lines[lines.length - 1] !== '') lines.push('');
        break;
      case 'break':
        flush();
        break;
      case 'text':
        line += line.endsWith(' ') || line === '' ? token.value.trimStart() : token.value;
        break;
      default: break;
    }
  }
  flush();

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The plain-text form that goes into `pages.body_text` and the tsvector.
const markdownToText = (md) =>
  md.replace(/^#{1,6}\s+/gm, '').replace(/^\s*-\s+/gm, '').replace(/\n{2,}/g, '\n\n').trim();

// ---------------------------------------------------------------------------
// Links (§9.5 step 4)
// ---------------------------------------------------------------------------
function extractLinks(dom, baseUrl) {
  const host = hostOf(baseUrl);
  const seen = new Set();
  const links = [];

  for (const a of DomUtils.findAll((n) => n.name === 'a', dom)) {
    const href = a.attribs?.href;
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;

    const resolved = absolute(href, baseUrl);
    if (!resolved) continue;

    const normalized = normalizeUrl(resolved);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const rel = (a.attribs.rel ?? '').toLowerCase();
    links.push({
      to_url: normalized,
      anchor_text: DomUtils.textContent(a).replace(/\s+/g, ' ').trim().slice(0, 300) || null,
      rel: rel || null,
      is_internal: hostOf(resolved) === host,
      // rel="nofollow" is the page's instruction not to pass trust or to follow.
      // The frontier honours it; the link is still recorded, because the link
      // graph is a record of what the page did, not of what we did about it.
      nofollow: rel.split(/\s+/).includes('nofollow'),
    });
  }
  return links;
}

// ---------------------------------------------------------------------------
const clean = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};

const text = (node) => (node ? DomUtils.textContent(node) : null);

function absolute(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function normaliseLang(value) {
  if (!value) return null;
  const tag = String(value).replace('_', '-').toLowerCase().split('-')[0];
  return /^[a-z]{2,3}$/.test(tag) ? tag : null;
}

function date(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // A publication date in the future is a template bug or a timezone artefact,
  // not news. Freshness decay would reward it, so it is dropped.
  if (d.getTime() > Date.now() + 86_400_000) return null;
  return d.toISOString();
}

const contentHash = (text) =>
  createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim()).digest();

/**
 * Charset detection (§9.5 step 1).
 *
 * Node decodes as UTF-8 by default, which is right for the overwhelming
 * majority and wrong in a way that is silently ugly for the rest -- a Romanian
 * page served as ISO-8859-2 becomes mojibake, and mojibake tokenises into
 * nothing a search will ever match. The header wins, then the meta tag, and the
 * caller re-decodes if the answer is not UTF-8.
 */
export function detectCharset(buffer, contentTypeHeader) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentTypeHeader ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  // Only the head is worth scanning, and the spec puts the declaration in the
  // first 1024 bytes.
  const head = buffer.subarray(0, 1024).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
                ?? /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}
