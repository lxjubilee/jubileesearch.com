// Sitemap, sitemap index, RSS and Atom parsing (§9.3).
//
// "Seeds from sitemap.xml, sitemap_index.xml, and RSS or Atom feeds first; falls
// back to link discovery only when no sitemap exists."
//
// The order matters more than it looks. A sitemap gives the whole set of a
// site's URLs in one request, with a change date attached; link discovery finds
// them one fetch at a time and finds the navigation furniture along with them.
// On a 5,000-page cap, starting from a sitemap is the difference between
// indexing a site and indexing its menus.

import { Parser } from 'htmlparser2';

const MAX_URLS = 50_000;   // the sitemap protocol's own per-file limit

/**
 * Parse any of the four formats. Returns URLs with whatever metadata the format
 * carried, and flags a sitemap index so the caller knows to recurse.
 *
 * @returns {{kind: 'urlset'|'sitemapindex'|'feed'|'unknown', entries: Array}}
 */
export function parseSitemap(xml) {
  const entries = [];
  let kind = 'unknown';

  // Element stack, so <loc> is attributed to the <url> or <sitemap> that
  // contains it rather than to whatever came last.
  const stack = [];
  let current = null;
  let textTarget = null;
  let buffer = '';

  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = local(name);
      stack.push(tag);

      switch (tag) {
        case 'urlset': kind = 'urlset'; break;
        case 'sitemapindex': kind = 'sitemapindex'; break;
        case 'rss': case 'feed': kind = 'feed'; break;

        case 'url': case 'sitemap': case 'item': case 'entry':
          current = {};
          break;

        case 'loc': case 'lastmod': case 'changefreq': case 'priority':
        case 'title': case 'pubdate': case 'updated': case 'published':
          textTarget = tag;
          buffer = '';
          break;

        case 'link':
          // The two feed formats disagree about where the URL lives, and both
          // are called <link>.
          //
          // Atom puts it in an href attribute, with rel="alternate" (or no rel)
          // meaning the entry itself; rel="self" and rel="edit" point at the
          // feed and its API and are not entries.
          //
          // RSS puts it in the element's text. Handling only the Atom form
          // silently yields zero entries for every RSS feed, which reads as a
          // site with no feed rather than as a parser that cannot read one.
          if (!current) break;
          if (attribs.href) {
            if (!attribs.rel || attribs.rel === 'alternate') current.loc = attribs.href;
          } else {
            textTarget = 'link';
            buffer = '';
          }
          break;

        default: break;
      }
    },

    ontext(text) {
      if (textTarget) buffer += text;
    },

    onclosetag(name) {
      const tag = local(name);
      stack.pop();

      if (textTarget === tag) {
        const value = buffer.trim();
        buffer = '';
        textTarget = null;
        if (current && value) {
          switch (tag) {
            case 'loc': current.loc = value; break;
            // RSS. An Atom <link> with an href has already set loc from the
            // attribute and never reaches here, so this cannot overwrite it.
            case 'link': current.loc ??= value; break;
            case 'lastmod': case 'updated': case 'published': case 'pubdate':
              current.lastmod ??= value; break;
            case 'changefreq': current.changefreq = value; break;
            case 'priority': current.priority = Number(value); break;
            case 'title': current.title = value; break;
            default: break;
          }
        }
      }

      if (['url', 'sitemap', 'item', 'entry'].includes(tag)) {
        if (current?.loc && entries.length < MAX_URLS) {
          entries.push({
            url: current.loc,
            lastmod: parseDate(current.lastmod),
            changefreq: current.changefreq ?? null,
            priority: Number.isFinite(current.priority) ? current.priority : null,
            title: current.title ?? null,
            isIndex: tag === 'sitemap',
          });
        }
        current = null;
      }
    },
  }, { xmlMode: true, decodeEntities: true, lowerCaseTags: true });

  parser.write(String(xml ?? ''));
  parser.end();

  return { kind, entries };
}

// Namespaced tags arrive as 'ns:tag'. Only the local name is ever significant
// here, and a feed that declares its namespace differently is still a feed.
const local = (name) => {
  const tag = String(name).toLowerCase();
  const colon = tag.indexOf(':');
  return colon >= 0 ? tag.slice(colon + 1) : tag;
};

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The conventional places a sitemap lives, tried in order when robots.txt names
 * none. Not a guess at content -- these are the paths the sitemap protocol and
 * the common CMSs actually publish at.
 */
export const CONVENTIONAL_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/wp-sitemap.xml',
  '/sitemap/sitemap.xml',
  '/feed',
  '/rss.xml',
  '/atom.xml',
];
