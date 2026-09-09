// Source-first ingest for T1 (R5, §9.1).
//
// "Owned content already exists as markdown with YAML frontmatter on the CDN.
// Crawling the rendered HTML discards that structure and then pays a
// boilerplate-stripping tax to recover a degraded version of text that was
// clean at the source."
//
// This module is the parse-and-map half: markdown in, a `pages` row and a
// heading tree out. It does no I/O, which is what makes it testable and what
// lets the same code serve the nightly enumeration, the publish webhook, and a
// one-off reingest from the admin console.

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(source) {
  const match = String(source ?? '').match(FRONTMATTER);
  if (!match) return { data: {}, body: String(source ?? '') };
  try {
    const data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) ?? {};
    return {
      data: typeof data === 'object' && !Array.isArray(data) ? data : {},
      body: source.slice(match[0].length),
    };
  } catch (err) {
    // A malformed frontmatter block is a content bug, not an ingest bug. Take
    // the body and record the problem; refusing the page outright would drop an
    // article from search because of a stray colon.
    return { data: {}, body: source.slice(match[0].length), error: err.message };
  }
}

// §9.1 step 3. Frontmatter keys vary across the network's publishing systems, so
// each column accepts several source names. The order within an array is the
// precedence order.
const FIELD_MAP = {
  title: ['title', 'headline'],
  description: ['description', 'summary', 'excerpt', 'blurb'],
  author: ['author', 'persona', 'writer', 'by'],
  persona: ['persona', 'inspire_persona', 'author'],
  category: ['category', 'section', 'collection'],
  office: ['office', 'fivefold_office', 'five_fold', 'fivefold'],
  // 'date_created' / 'date_updated' are what the JubileeVerse CDN bundles use.
  // Added to the existing map rather than special-cased in the CDN importer, so
  // there stays one place that knows what a frontmatter date can be called.
  published_at: ['created', 'published', 'date', 'published_at', 'date_created'],
  modified_at: ['updated', 'modified', 'updated_at', 'modified_at', 'date_updated'],
  language: ['language', 'lang', 'locale'],
  slug: ['slug', 'permalink', 'path'],
  og_image_url: ['image', 'og_image', 'cover', 'thumbnail'],
};

const ARRAY_FIELDS = {
  tags: ['tags', 'keywords', 'topics'],
  characters: ['characters', 'cast', 'people'],
  related_slugs: ['related_slugs', 'related', 'see_also'],
};

const first = (data, names) => {
  for (const name of names) {
    const v = data[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

const toArray = (v) => {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
};

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Map frontmatter and body to the columns of `pages`.
 *
 * @param {string} source        raw .md file contents
 * @param {object} domain        { host, url_template }
 * @param {string} sourcePath    path under the domain's source_root
 */
export function mapToPage(source, domain, sourcePath) {
  const { data, body, error } = parseFrontmatter(source);

  const headings = extractHeadings(body);
  const text = stripMarkdown(body);
  const slug = String(first(data, FIELD_MAP.slug) ?? deriveSlug(sourcePath));

  return {
    source_path: sourcePath,
    url: buildUrl(domain, data, slug),
    title: str(first(data, FIELD_MAP.title)),
    description: str(first(data, FIELD_MAP.description)),
    author: str(first(data, FIELD_MAP.author)),
    persona: str(first(data, FIELD_MAP.persona)),
    category: str(first(data, FIELD_MAP.category)),
    office: str(first(data, FIELD_MAP.office)),
    published_at: toDate(first(data, FIELD_MAP.published_at)),
    modified_at: toDate(first(data, FIELD_MAP.modified_at)),
    language: str(first(data, FIELD_MAP.language)) ?? null,
    tags: toArray(first(data, ARRAY_FIELDS.tags)),
    characters: toArray(first(data, ARRAY_FIELDS.characters)),
    related_slugs: toArray(first(data, ARRAY_FIELDS.related_slugs)),

    // §2.2 and P10. The OpenGraph image URL is "retained as a metadata field for
    // possible future use by other Jubilee systems, and it is never fetched,
    // never cached, and never rendered in search results at any tier." It is
    // written to this column and read by nothing in src/query/.
    og_image_url: str(first(data, FIELD_MAP.og_image_url)),

    body_text: text,
    word_count: countWords(text),
    content_hash: contentHash(text),
    headings,
    frontmatter_error: error ?? null,
  };
}

const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

// §9.1 step 6: "Map slug to the live public URL using the domain's URL template,
// so results link to the published page even though the index was built from
// source." Getting this wrong means every Zone A result 404s, which is why the
// template is per-domain configuration and not a convention.
export function buildUrl(domain, data, slug) {
  const template = domain.url_template || 'https://{host}/{slug}';
  const values = {
    host: domain.host,
    slug: String(slug).replace(/^\/+|\/+$/g, ''),
    category_slug: slugify(first(data, FIELD_MAP.category) ?? ''),
    persona_slug: slugify(first(data, FIELD_MAP.persona) ?? ''),
    lang: str(first(data, FIELD_MAP.language)) ?? '',
  };
  return template
    .replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')
    .replace(/([^:]);?\/{2,}/g, '$1/')   // collapse // left by an empty segment
    .replace(/\/+$/, '');
}

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const deriveSlug = (sourcePath) =>
  String(sourcePath).replace(/\.mdx?$/i, '').split('/').pop();

// §9.1 step 4: "Strip markdown syntax to plain text for body_text while
// preserving heading structure for the chunker's heading_path."
//
// Order matters. Fenced code goes first because its contents must not be parsed
// as markdown; links before emphasis so that `[**x**](y)` keeps `x`.
export function stripMarkdown(md) {
  return String(md ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')       // a second frontmatter block
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/^\s{0,3}>\s?/gm, '')                        // blockquote markers
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                // images: dropped entirely (P10)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')              // links keep their text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                   // heading markers, text kept
    .replace(/^\s{0,3}([*+-]|\d+\.)\s+/gm, '')            // list markers
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ')            // thematic breaks
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')                             // stray inline HTML
    .replace(/\|/g, ' ')                                  // table pipes
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The heading tree, in document order, with the character offset in the
 * *stripped* text where each section starts. The chunker splits on these first
 * (§12.1), and §9.1 notes this is cleaner than inferring structure from HTML
 * precisely because the markdown says it outright.
 */
export function extractHeadings(md) {
  const out = [];
  const lines = String(md ?? '').split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: stripMarkdown(m[2]) });
  }
  return out;
}

export const countWords = (text) => String(text ?? '').split(/\s+/).filter(Boolean).length;

// §9.5 change detection and §9.6 exact dedupe both key on this. Computed over
// the *normalised* main text, so a whitespace-only edit does not cost a reindex
// or an embedding batch (acceptance criterion 3).
export const contentHash = (text) =>
  createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim()).digest();

export const urlHash = (url) =>
  createHash('sha256').update(normalizeUrl(url)).digest();

// One canonical form per address, so the same page discovered three ways is one
// row. Fragment and the usual tracking parameters are noise, not identity.
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    for (const p of [...u.searchParams.keys()]) {
      // utm_ is a prefix, not a whole name: utm_source, utm_campaign, utm_medium.
      if (/^utm_/i.test(p) || /^(fbclid|gclid|msclkid|mc_eid|ref)$/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    u.searchParams.sort();
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}
