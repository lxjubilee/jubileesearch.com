// The JubileeVerse published-article bundles on the CDN.
//
// Traced from the site's own code rather than guessed. `src/lib/articles.ts` in
// the jubileeverse.com checkout documents the layout and states the rule this
// module follows most strictly:
//
//   "The manifest is the source of truth: a category with `"articles": []`
//    renders as empty even if stray files sit beside it. Anything not listed
//    there ... is not published."
//
//   <CDN_BASE_URL>/articles/<folder>/articles.json   the manifest
//   <CDN_BASE_URL>/articles/<folder>/<file>.md       frontmatter + body
//   <CDN_BASE_URL>/articles/<folder>/images/<file>   hero image (never fetched, P10)
//
// There is deliberately no root catalogue. `src/lib/cdn.ts` records that the old
// `articles_catalog.json` "is not published", and /articles_catalog.json,
// /articles/index.json and /articles/manifest.json all return 404 -- verified.
// Enumeration is the five category manifests and nothing else.

const DEFAULT_BASE = 'https://cdn.jubileeverse.com';

export const CDN_BASE = (process.env.JUBILEEVERSE_CDN_BASE || DEFAULT_BASE).replace(/\/+$/, '');
export const ARTICLES_ROOT = `${CDN_BASE}/articles`;

/**
 * Route slug -> published folder, copied from `FOLDER_BY_ROUTE` in the site's
 * own `src/lib/articles.ts`.
 *
 * One entry, and it is load-bearing: the nav links to "torah-hebraic-insights"
 * (the taxonomy slug) but the bundle is published as "torah-hebraic". Deriving
 * the folder from the category name instead would 404 on exactly this one.
 */
const FOLDER_BY_ROUTE = {
  'torah-hebraic-insights': 'torah-hebraic',
};

const ROUTE_BY_FOLDER = Object.fromEntries(
  Object.entries(FOLDER_BY_ROUTE).map(([route, folder]) => [folder, route]),
);

/** The five published folders, in the site's reading order. */
export const CDN_FOLDERS = [
  'covenant-identity',
  'teshuvah-restoration',
  'shalom-salvation',
  'celebration-mishpakhah',
  'torah-hebraic',
];

/** The route slug for a published folder -- what the public URL uses. */
export const routeForFolder = (folder) => ROUTE_BY_FOLDER[folder] ?? folder;

export const manifestUrl = (folder) => `${ARTICLES_ROOT}/${folder}/articles.json`;

/** The markdown URL for one manifest entry. Always the manifest's own `file`. */
export const articleUrl = (folder, file) =>
  `${ARTICLES_ROOT}/${folder}/${String(file).replace(/^\/+/, '')}`;

/**
 * The stable page identity, matching the site's `makeArticleId`:
 * `<categorySlug>__<slug>`, a single path segment because it is interpolated
 * into /article/<id>. The category half is the ROUTE slug, not the folder.
 */
export const makeArticleId = (routeSlug, slug) => `${routeSlug}__${slug}`;

/** Where a reader lands. The site's reader route is /article/<id>. */
export const publicUrl = (host, routeSlug, slug) =>
  `https://${host}/article/${makeArticleId(routeSlug, slug)}`;

/**
 * Fetch one category manifest, with a conditional GET when a validator is known.
 *
 * Returns `{ status: 304 }` when nothing changed, which lets a sync skip a whole
 * category of up to 120 articles for the cost of one request.
 */
export async function fetchManifest(folder, { etag = null, lastModified = null, timeoutMs = 20_000 } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'JubileeSearchImporter/1.0' };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const res = await fetch(manifestUrl(folder), { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { status: 304, folder };
  if (!res.ok) throw new Error(`manifest for ${folder} returned ${res.status}`);

  const body = await res.json();
  return {
    status: 200,
    folder,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    category: body.category ?? null,
    categorySlug: body.category_slug ?? routeForFolder(folder),
    office: body.office ?? null,
    updated: body.updated ?? null,
    // Only what the manifest lists, and only what it calls published. A .md file
    // sitting beside the manifest but absent from it is not published content.
    articles: (body.articles ?? []).filter((a) => a && a.file && a.slug
      && String(a.status ?? '').toLowerCase() === 'published'),
    listedTotal: (body.articles ?? []).length,
  };
}

/**
 * Fetch one article's markdown, conditionally.
 *
 * The CDN sends ETag and Last-Modified and honours If-None-Match -- verified
 * against the live host. That is what keeps a routine sync of 600 articles to
 * 600 cheap 304s instead of 600 downloads.
 */
export async function fetchArticleMarkdown(folder, file, { etag = null, lastModified = null, timeoutMs = 20_000 } = {}) {
  const headers = { accept: 'text/markdown, text/plain, */*', 'user-agent': 'JubileeSearchImporter/1.0' };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const url = articleUrl(folder, file);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

  if (res.status === 304) return { status: 304, url };
  if (res.status === 404) return { status: 404, url };
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);

  return {
    status: 200,
    url,
    body: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}
