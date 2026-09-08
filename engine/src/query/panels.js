// The things that render around the two zones: the navigational match, the
// entity panel, the scripture card, and thread continuation.
//
// Every one of them is text (P10), and none of them is authored here (P7). The
// scripture card quotes JSV verbatim, the entity panel stores JubileePedia's
// summary verbatim, and thread continuation is a join over frontmatter that the
// writing team already wrote.

import { env } from '../config.js';

// ---------------------------------------------------------------------------
// Navigational (§13.2): "Query matches a registered domain name, site display
// name, or a known brand token with high confidence."
//
// High confidence is the whole test. A near-match must not hijack a topical
// query -- someone searching "jubilee circles small group" wants results, not a
// redirect to jubileecircles.com. So the match is exact against the host with
// its suffix and separators removed, or exact against the display name.
// ---------------------------------------------------------------------------
const NAV_SQL = `
  SELECT d.id, d.host, d.display_name, d.tier
  FROM domains d
  WHERE d.status = 'active'
    AND (
          d.host = $1
       OR regexp_replace(d.host, '\\.[a-z]+$', '') = replace($1, ' ', '')
       OR lower(d.display_name) = $1
        )
  ORDER BY (d.host = $1) DESC, d.tier
  LIMIT 1`;

const DEEP_LINKS_SQL = `
  SELECT p.url, p.title, p.description
  FROM servable_pages p
  WHERE p.domain_id = $1
  ORDER BY COALESCE(p.engagement_score, 0) DESC, COALESCE(p.quality_score, 0) DESC
  LIMIT 3`;

export async function findNavigational(db, normalized) {
  if (!normalized || normalized.length > 60) return null;
  const { rows } = await db.query(NAV_SQL, [normalized]);
  return rows[0] ? { id: Number(rows[0].id), host: rows[0].host,
                     display_name: rows[0].display_name, tier: rows[0].tier } : null;
}

export async function navigationalResult(db, domain) {
  const { rows } = await db.query(DEEP_LINKS_SQL, [domain.id]);
  return {
    host: domain.host,
    title: domain.display_name ?? domain.host,
    url: `https://${domain.host}/`,
    deep_links: rows.map((r) => ({ url: r.url, title: r.title })),
  };
}

// ---------------------------------------------------------------------------
// Entity panel (R10, §7.8, §13.2). Text only, verbatim from JubileePedia.
// ---------------------------------------------------------------------------
const ENTITY_SQL = `
  SELECT e.entity_key, e.entity_type, e.display_name, e.summary,
         e.source_url, e.facts, e.related_urls
  FROM entity_aliases a
  JOIN entities e ON e.id = a.entity_id AND e.active
  WHERE a.alias = $1 AND (a.lang IS NULL OR a.lang = $2 OR a.lang = 'en')
  LIMIT 1`;

export async function findEntity(db, normalized, lang) {
  if (!normalized) return null;
  const { rows } = await db.query(ENTITY_SQL, [normalized, lang]);
  if (!rows[0]) return null;
  return {
    key: rows[0].entity_key,
    type: rows[0].entity_type,
    name: rows[0].display_name,
    summary: rows[0].summary,
    facts: rows[0].facts ?? [],
    related: rows[0].related_urls ?? [],
    // The panel must credit JubileePedia and link back to it. This is quoted
    // content, and the source is not optional.
    source_url: rows[0].source_url,
    source_name: 'JubileePedia',
  };
}

// ---------------------------------------------------------------------------
// Scripture card (R3, §13.2, §16 JSV row).
//
// "It is quoted, never paraphrased, never commented on, and never generated.
// Cited simply as JSV with no edition label... If the passage cannot be
// retrieved with certainty, the card is not rendered at all and the query falls
// through to normal results. Silence is correct; a wrong verse is not."
//
// Every failure path here returns null. There is no fallback translation, no
// nearest-verse guess, and no cached approximation.
// ---------------------------------------------------------------------------
export async function scriptureCard(reference) {
  if (!env.jsvApiUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    const url = new URL(`${env.jsvApiUrl.replace(/\/$/, '')}/passage`);
    url.searchParams.set('book', reference.book);
    url.searchParams.set('chapter', String(reference.chapter));
    if (reference.verse !== null) url.searchParams.set('verse', String(reference.verse));
    if (reference.verseEnd !== null) url.searchParams.set('verse_end', String(reference.verseEnd));

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();

    // A response that does not contain the passage is not a passage. Rendering
    // an empty card would be worse than rendering none.
    const verses = json?.verses;
    if (!Array.isArray(verses) || verses.length === 0) return null;

    // Guard against the API answering with a *different* passage than the one
    // asked for -- a redirect, a fuzzy match, a stale cache. Certainty means the
    // reference that comes back is the reference that went out.
    if (json.book && normaliseBook(json.book) !== normaliseBook(reference.book)) return null;
    if (json.chapter && Number(json.chapter) !== reference.chapter) return null;

    return {
      reference: reference.ref,
      verses: verses.map((v) => ({ verse: Number(v.verse), text: String(v.text) })),
      citation: 'JSV',
      chapter_url: json.chapter_url ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const normaliseBook = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Thread continuation (R10, §13.9).
//
// "For T1 results, if the page has related_slugs or shares characters with other
// indexed pages, render up to 3 'continue this thread' links beneath the result.
// ... It turns search from an exit ramp into an entry point, which is much of
// the reason to run your own engine."
//
// One query for the whole Zone A block rather than one per result: three or
// five extra round trips would eat the 30 ms assembly budget for a feature that
// is a join.
// ---------------------------------------------------------------------------
const THREADS_SQL = `
  WITH seed AS (
      SELECT p.id, p.url, p.related_slugs, p.characters
      FROM pages p WHERE p.id = ANY($1::bigint[])
  )
  SELECT s.id AS seed_id, t.url, t.title,
         CASE WHEN t.related_slugs && s.related_slugs THEN 'related' ELSE 'character' END AS via
  FROM seed s
  JOIN servable_pages t
    ON t.tier = 'T1' AND t.id <> s.id
   AND (
         t.related_slugs && s.related_slugs
      OR t.characters   && s.characters
       )
  ORDER BY s.id, COALESCE(t.engagement_score, 0) DESC`;

export async function threadContinuations(db, results) {
  const t1 = results.filter((r) => r.tier === 'T1'
    && ((r.related_slugs?.length ?? 0) > 0 || (r.characters?.length ?? 0) > 0));
  if (t1.length === 0) return new Map();

  const { rows } = await db.query(THREADS_SQL, [t1.map((r) => r.page_id)]);
  const bySeed = new Map();
  const seenUrls = new Set(results.map((r) => r.url));

  for (const row of rows) {
    const seed = Number(row.seed_id);
    const list = bySeed.get(seed) ?? [];
    // Never suggest continuing to a page already on screen.
    if (list.length >= 3 || seenUrls.has(row.url)) continue;
    list.push({ url: row.url, title: row.title, via: row.via });
    bySeed.set(seed, list);
  }
  return bySeed;
}
