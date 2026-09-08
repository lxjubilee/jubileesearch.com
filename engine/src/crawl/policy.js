// Per-domain URL admission (§8.3, §9.4).
//
// Decides whether a discovered URL is allowed to enter the frontier at all,
// before robots.txt is consulted and long before anything is fetched. Pure, so
// it is testable and so the same rules apply to a sitemap seed, a discovered
// link and a manual submission.
//
// The image rule here is not a performance filter. §9.4: "Images are never
// fetched." P10 makes that a product principle rather than a preference, so a
// URL that looks like an image is refused at the frontier and never reaches the
// fetcher, where a `Content-Type` check would be the second line of defence
// rather than the first.

export const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/pdf',
];

// Extensions that are certainly not a document. Images lead the list because of
// P10; the rest are simply not text and would cost a 5 MB fetch to discover it.
const REFUSED_EXTENSIONS = new Set([
  // images -- P10, never fetched at any tier
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'heic',
  // audio and video -- out of scope (§2.2)
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac',
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv',
  // archives and binaries
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso',
  'exe', 'msi', 'deb', 'rpm', 'apk', 'bin', 'jar',
  // assets
  'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  // office formats we have no extractor for
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
]);

// Query parameters that mark a URL as a view of a page rather than a page:
// print stylesheets, session ids, replytocom threads. Following them multiplies
// the crawl without adding a document.
const TRAP_PARAMS = /^(sessionid|phpsessid|jsessionid|sid|replytocom|share|print|utm_|fbclid|gclid)/i;

// Paths that are almost always an infinite space rather than content. A calendar
// will happily generate a page for every day until the heat death of the
// universe, and a crawler with a depth limit will spend all of it there.
const TRAP_PATHS = [
  /\/(wp-admin|wp-login|xmlrpc\.php|wp-json)(\/|$)/i,
  /\/(cart|checkout|basket|account|login|logout|signin|signup|register)(\/|$)/i,
  /\/(calendar|events?)\/\d{4}\/\d{2}\/\d{2}/i,
  /\/(tag|tags|author|search)\/.*\/page\/\d{3,}/i,
  /\/feed\/?$/i,
  /\/(print|amp)\/?$/i,
];

/**
 * @param {string} rawUrl
 * @param {object} domain   row from `domains`
 * @param {object} context  { depth, fromHost }
 * @returns {{allowed: boolean, reason?: string, url?: string}}
 */
export function admit(rawUrl, domain, context = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'unparseable url' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: `unsupported scheme ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const domainHost = String(domain.host).toLowerCase().replace(/^www\./, '');
  // Subdomains count as the same property: blog.example.com belongs to
  // example.com's crawl budget and its policy, not to a separate registration.
  if (host !== domainHost && !host.endsWith(`.${domainHost}`)) {
    return { allowed: false, reason: `off-domain (${host})` };
  }

  const depth = context.depth ?? 0;
  if (domain.max_depth !== null && depth > domain.max_depth) {
    return { allowed: false, reason: `depth ${depth} exceeds max_depth ${domain.max_depth}` };
  }

  const extension = extensionOf(url.pathname);
  if (extension && REFUSED_EXTENSIONS.has(extension)) {
    return { allowed: false, reason: `refused extension .${extension}` };
  }

  for (const trap of TRAP_PATHS) {
    if (trap.test(url.pathname)) return { allowed: false, reason: 'crawler trap path' };
  }

  for (const param of url.searchParams.keys()) {
    if (TRAP_PARAMS.test(param)) return { allowed: false, reason: `trap parameter ${param}` };
  }

  // A path with more than eight segments is nearly always generated rather than
  // authored, and is the shape faceted navigation takes when it explodes.
  if (url.pathname.split('/').filter(Boolean).length > 8) {
    return { allowed: false, reason: 'path too deep' };
  }

  // Per-domain patterns from the registry. Deny is evaluated first so that an
  // allow pattern cannot resurrect something an editor has explicitly excluded.
  for (const pattern of domain.deny_patterns ?? []) {
    if (safeTest(pattern, url.href)) return { allowed: false, reason: `deny_pattern ${pattern}` };
  }
  const allowPatterns = domain.allow_patterns ?? [];
  if (allowPatterns.length > 0 && !allowPatterns.some((p) => safeTest(p, url.href))) {
    return { allowed: false, reason: 'no allow_pattern matched' };
  }

  return { allowed: true, url: url.href };
}

function extensionOf(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return null;
  return last.slice(dot + 1).toLowerCase();
}

// A bad pattern in the registry must not take the crawl down. It is treated as
// not matching, which for a deny pattern is the permissive reading -- so the
// admin console validates patterns on write, the same way best bets do.
function safeTest(pattern, value) {
  try { return new RegExp(pattern).test(value); } catch { return false; }
}

/**
 * Content-type gate, applied to the response before the body is read (§9.4).
 * Separate from `admit` because a URL with no extension can still turn out to be
 * a JPEG.
 */
export function acceptsContentType(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!type) return { accepted: false, reason: 'no content-type' };
  if (type.startsWith('image/')) return { accepted: false, reason: 'images are never fetched (P10)' };
  if (!ALLOWED_CONTENT_TYPES.includes(type)) return { accepted: false, reason: `content-type ${type}` };
  return { accepted: true, type };
}

/**
 * Adaptive recrawl interval (§9.3).
 *
 * "A domain unchanged across three consecutive runs has its interval increased
 * by 50%, capped at 30 days. A domain that changed materially has it decreased
 * toward its floor."
 *
 * @param {number} currentHours
 * @param {number} floorHours       the tier default from §8.3
 * @param {number} unchangedRuns    consecutive runs with no changed page
 * @param {boolean} changed         this run found changes
 */
export function nextInterval(currentHours, floorHours, unchangedRuns, changed) {
  const CAP_HOURS = 30 * 24;
  if (changed) {
    // Halve toward the floor rather than snapping to it: a site that publishes
    // once should not be crawled hourly forever after.
    return Math.max(floorHours, Math.round(currentHours / 2));
  }
  if (unchangedRuns < 3) return currentHours;
  return Math.min(CAP_HOURS, Math.round(currentHours * 1.5));
}
