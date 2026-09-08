// robots.txt parsing and matching (§9.4, principle P6).
//
// "Robots.txt, crawl-delay, and rate limits are honored on external domains
// without exception." Acceptance criterion 5 requires this to be provable
// against a controlled disallow rule, so the matcher is a pure function over a
// parsed file and is tested directly.
//
// Follows RFC 9309 (the 2022 standardisation of the Robots Exclusion Protocol),
// plus `Crawl-delay`, which is not in the RFC but is in the specification and is
// widely published by exactly the kind of small ministry site this crawler will
// meet.
//
// The rules that matter and are easy to get wrong:
//
//   * Groups are selected by the *most specific* matching user-agent token, not
//     the first one. A file with a `*` group and a `JubileeSearchBot` group must
//     use the latter, even if `*` came first.
//   * Within the winning group, the *longest* matching path rule wins, and a tie
//     goes to Allow. This is what makes the common
//         Disallow: /
//         Allow: /public/
//     pattern work at all.
//   * A group that matched but has no rules allows everything. An empty
//     `Disallow:` is an allow, not a disallow of nothing.
//   * A 4xx on robots.txt means allow all; a 5xx means allow nothing. That
//     asymmetry is deliberate in the RFC and is implemented in the fetcher.

const MAX_BYTES = 512 * 1024;   // RFC 9309 says parse at least 500 KiB

/**
 * @param {string} text  the body of robots.txt
 * @returns {{groups: Array, sitemaps: string[]}}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];

  let current = null;
  // A run of consecutive User-agent lines forms one group with several agents.
  // A rule line ends the run; the next User-agent starts a new group.
  let acceptingAgents = false;

  for (const rawLine of String(text ?? '').slice(0, MAX_BYTES).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent':
        if (!acceptingAgents || !current) {
          current = { agents: [], rules: [], crawlDelay: null };
          groups.push(current);
          acceptingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;

      case 'disallow':
      case 'allow':
        if (!current) break;              // a rule before any user-agent line
        acceptingAgents = false;
        // "Disallow:" with an empty value is an allow-all, and must not be
        // stored as a rule matching the empty prefix (which would match every
        // path and disallow the site).
        if (field === 'disallow' && value === '') break;
        current.rules.push({ allow: field === 'allow', path: value });
        break;

      case 'crawl-delay': {
        if (!current) break;
        acceptingAgents = false;
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
        break;
      }

      case 'sitemap':
        // Sitemap is a global directive, not part of any group.
        if (value) sitemaps.push(value);
        break;

      default:
        break;
    }
  }

  return { groups, sitemaps };
}

/**
 * Pick the group that applies to a user agent: the longest matching token,
 * falling back to `*`. Returns null when nothing matches, which means allow all.
 */
export function groupFor(parsed, userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  let best = null;
  let bestLength = -1;

  for (const group of parsed.groups ?? []) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (bestLength < 0) { best = group; bestLength = 0; }
        continue;
      }
      // RFC 9309 matches the product token as a substring of the crawler's
      // user-agent string, case-insensitively.
      if (ua.includes(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }
  return best;
}

// Translate a robots path pattern to a regular expression. `*` is any run of
// characters and a trailing `$` anchors the end; everything else is literal.
function toRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') { source += '.*'; continue; }
    if (ch === '$' && i === pattern.length - 1) { source += '$'; continue; }
    source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(source); } catch { return null; }
}

// The comparison length for "longest match wins" is the pattern's own length,
// per RFC 9309 -- not the length of the text it matched.
function matchLength(rule, path) {
  const re = toRegExp(rule.path);
  if (!re || !re.test(path)) return -1;
  return rule.path.length;
}

/**
 * @param {object} parsed     from parseRobots()
 * @param {string} userAgent
 * @param {string} path       the path and query of the URL, e.g. '/a/b?c=1'
 * @returns {{allowed: boolean, rule: object|null, crawlDelaySeconds: number|null}}
 */
export function isAllowed(parsed, userAgent, path) {
  const group = groupFor(parsed, userAgent);
  if (!group) return { allowed: true, rule: null, crawlDelaySeconds: null };

  const target = path || '/';
  let winner = null;
  let winnerLength = -1;

  for (const rule of group.rules) {
    const length = matchLength(rule, target);
    if (length < 0) continue;
    // Longest wins; on an exact tie, Allow wins.
    if (length > winnerLength || (length === winnerLength && rule.allow && !winner?.allow)) {
      winner = rule;
      winnerLength = length;
    }
  }

  return {
    allowed: winner ? winner.allow : true,
    rule: winner,
    crawlDelaySeconds: group.crawlDelay,
  };
}

/**
 * Meta and header robots directives (§9.4: "honors X-Robots-Tag and
 * <meta name="robots"> directives").
 *
 * `noindex` means the page may be fetched but must not enter the index;
 * `nofollow` means its links must not be queued. They are independent, and
 * conflating them is the usual bug -- a noindex page's links are still worth
 * following, and that is often the whole point of a hub page.
 */
export function parseRobotsDirectives(value) {
  const tokens = String(value ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return {
    noindex: tokens.includes('noindex') || tokens.includes('none'),
    nofollow: tokens.includes('nofollow') || tokens.includes('none'),
    noarchive: tokens.includes('noarchive'),
  };
}

/**
 * X-Robots-Tag may appear several times and may be scoped to a named bot:
 *   X-Robots-Tag: noindex
 *   X-Robots-Tag: jubileesearchbot: nofollow
 * A directive addressed to another crawler is not ours to obey.
 */
export function parseXRobotsTag(headerValue, userAgentToken = 'jubileesearchbot') {
  const values = Array.isArray(headerValue) ? headerValue : [headerValue];
  const merged = { noindex: false, nofollow: false, noarchive: false };

  for (const value of values) {
    if (!value) continue;
    for (const part of String(value).split(',')) {
      const colon = part.indexOf(':');
      let directives = part;
      if (colon >= 0) {
        const scope = part.slice(0, colon).trim().toLowerCase();
        // A bare directive has no colon; anything before one is a bot name,
        // unless it happens to be a directive keyword with a value.
        if (!['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after'].includes(scope)) {
          if (scope !== userAgentToken.toLowerCase()) continue;
          directives = part.slice(colon + 1);
        }
      }
      const parsed = parseRobotsDirectives(directives);
      merged.noindex ||= parsed.noindex;
      merged.nofollow ||= parsed.nofollow;
      merged.noarchive ||= parsed.noarchive;
    }
  }
  return merged;
}
