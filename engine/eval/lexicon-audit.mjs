// Does the lexicon speak the corpus's spelling?
//
// A lexicon term that appears nowhere in the corpus bridges nothing. It is not a
// broken query — the query still returns something, just not by the bridge — so
// no test has ever caught one. That is precisely the failure R2 exists to prevent.
//
// THE CATEGORISATION THAT MATTERS, and the one a naive version of this gets wrong:
//
// A zero-occurrence term is NOT automatically a defect. "holy spirit" appears 0
// times in this corpus and "jesus" appears 0 times, because the corpus writes
// Ruach HaKodesh and Yeshua. Those two entries are the bridge WORKING — an
// English term absent from a Hebraic-register corpus is exactly what R2 exists
// to translate. Counting them as failures would produce a list arguing the
// lexicon should delete the terms that give it its whole purpose.
//
// So the unit of judgement is the CONCEPT, not the term, and the question is:
//
//   REACHABLE   at least one of the concept's terms occurs in the corpus, so a
//               query matching any term of it can reach the articles.
//   MISSPELLED  the corpus discusses the concept under a spelling the lexicon
//               does not list. Expansion fires and lands on a form the article
//               does not use — the worst case, because it looks like it worked.
//   UNCOVERED   nothing in the corpus discusses it under any listed spelling and
//               no near spelling exists either. The lexicon may be perfectly
//               correct; the corpus simply has no article to bridge to.
//
// Run: USE_PGLITE=1 PGLITE_DIR=.pglite-dev npm run eval:lexicon

import { writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const unaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Collapse a word to the shape it shares with another transliteration of the
 * same Hebrew. Deliberately aggressive: its job is to PROPOSE a pairing for a
 * human to judge, never to conclude one. It produces false pairs — bris/brass,
 * hesed/housed — so the corpus form and its frequency are always reported
 * beside it, and the caller is expected to read them.
 */
function skeleton(s) {
  return unaccent(String(s).toLowerCase())
    .replace(/[^a-z ]+/g, '')
    .replace(/kh|ch|ck|q/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/tz|ts/g, 'z')
    .replace(/(.)\1+/g, '$1')
    .replace(/h\b/g, '')
    .replace(/[aeiou]+/g, 'a')
    .trim();
}

/**
 * The skeleton alone is too generous — collapsing every vowel run to 'a' pairs
 * "yeshua" with "uses" and "grace" with "hour", which is noise presented as a
 * finding. A candidate must also be a plausible respelling of the same word:
 * same first letter, similar length, and within three edits.
 */
function plausible(a, b) {
  if (a[0] !== b[0]) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  return levenshtein(a, b) <= 3;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const { rows: terms } = await pool.query(`
  SELECT t.term, t.lang, t.register, t.weight, t.is_primary, c.concept_key, c.gloss
  FROM lexicon_terms t JOIN lexicon_concepts c ON c.id = t.concept_id
  ORDER BY c.concept_key, t.is_primary DESC, t.weight DESC`);

const { rows: pages } = await pool.query(`
  SELECT title, COALESCE(description,'') AS description, COALESCE(body_text,'') AS body_text
  FROM pages WHERE source_path LIKE 'cdn:%' AND status = 'indexed'`);

// Corpus vocabulary, tokenised — NOT substring matching. "hesed" is a substring
// of "chesed" and "mishpacha" of "mishpachah"; a LIKE '%term%' count reports
// both as present and is simply wrong.
const grams = [null, new Map(), new Map(), new Map()];
const pagesWith = [null, new Map(), new Map(), new Map()];
for (const p of pages) {
  const words = unaccent(`${p.title} ${p.description} ${p.body_text}`.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const seen = [null, new Set(), new Set(), new Set()];
  for (let i = 0; i < words.length; i += 1) {
    for (let n = 1; n <= 3; n += 1) {
      if (i + n > words.length) break;
      const g = words.slice(i, i + n).join(' ');
      grams[n].set(g, (grams[n].get(g) ?? 0) + 1);
      seen[n].add(g);
    }
  }
  for (let n = 1; n <= 3; n += 1) {
    for (const g of seen[n]) pagesWith[n].set(g, (pagesWith[n].get(g) ?? 0) + 1);
  }
}
const count = (t) => { const n = Math.min(t.split(' ').length, 3); return grams[n].get(t) ?? 0; };
const docs = (t) => { const n = Math.min(t.split(' ').length, 3); return pagesWith[n].get(t) ?? 0; };

// Skeleton index over corpus vocabulary, for proposing near spellings.
const bySkeleton = new Map();
for (let n = 1; n <= 2; n += 1) {
  for (const [g, c] of grams[n]) {
    if (c < 2) continue;                       // a one-off is usually a typo or a name
    const k = skeleton(g);
    if (k.length < (n === 1 ? 3 : 5)) continue;
    if (!bySkeleton.has(k)) bySkeleton.set(k, []);
    bySkeleton.get(k).push({ form: g, hits: c, pages: docs(g) });
  }
}

// ---------------------------------------------------------------------------
// Per concept.

const concepts = new Map();
for (const t of terms) {
  if (!concepts.has(t.concept_key)) {
    concepts.set(t.concept_key, { concept: t.concept_key, gloss: t.gloss, terms: [] });
  }
  const term = unaccent(t.term.toLowerCase());
  const hits = count(term);
  // Near spellings are looked for on EVERY term, not only dead ones. The
  // mishpachah case is exactly why: the listed spelling does occur (2 pages), so
  // a dead-terms-only search would call the concept reachable and never notice
  // that the corpus writes it another way on ten.
  const near = (bySkeleton.get(skeleton(term)) ?? [])
    .filter((c) => c.form !== term && plausible(term, c.form))
    .sort((a, b) => b.hits - a.hits).slice(0, 4);
  concepts.get(t.concept_key).terms.push({
    term: t.term, lang: t.lang, register: t.register, is_primary: t.is_primary,
    hits, pages: docs(term), near_spellings: near,
  });
}

for (const c of concepts.values()) {
  const live = c.terms.filter((t) => t.hits > 0);
  c.reachable = live.length > 0;
  c.corpus_forms = live.map((t) => `${t.term} (${t.pages}p)`);
  // A spelling the corpus uses for this concept that the lexicon does not list.
  // Only proposed from a term of the SAME concept, so it is a candidate for
  // "this concept, spelled otherwise" rather than a free-floating word.
  const proposed = new Map();
  for (const t of c.terms) {
    // Only the Hebrew register. Transliteration is where spelling varies; an
    // English term's near-neighbours are inflections ("family"/"families"),
    // which the tsquery stemmer already handles and this should not report.
    if (t.register !== 'OHI') continue;
    for (const n of t.near_spellings) {
      if (c.terms.some((x) => unaccent(x.term.toLowerCase()) === n.form)) continue;
      const prev = proposed.get(n.form);
      if (!prev || n.hits > prev.hits) proposed.set(n.form, { ...n, from: t.term });
    }
  }
  c.unlisted_spellings = [...proposed.values()].sort((a, b) => b.hits - a.hits);
  // Dominance is judged WITHIN the Hebrew register, not across the whole concept.
  // Comparing an unlisted Hebrew spelling against the concept's English term is
  // meaningless: "family" outnumbers every transliteration of mishpachah, which
  // would report the concept healthy while its Hebrew side is unreachable.
  const hebrew = c.terms.filter((t) => t.register === 'OHI');
  const best = c.unlisted_spellings[0];
  const bestListed = hebrew.filter((t) => t.hits > 0).sort((a, b) => b.pages - a.pages)[0]
    ?? { pages: 0 };
  const hebrewLive = c.terms.filter((t) => t.register === 'OHI' && t.hits > 0).length;
  c.status = !c.reachable && c.unlisted_spellings.length ? 'MISSPELLED'
    : !c.reachable ? 'UNCOVERED'
    : best && bestListed && best.pages > bestListed.pages ? 'MISSPELLED-DOMINANT'
    : 'REACHABLE';
  c.dead_terms = c.terms.filter((t) => t.hits === 0).map((t) => t.term);
}

const all = [...concepts.values()];
const group = (s) => all.filter((c) => c.status === s);

const out = {
  ran_at: new Date().toISOString(),
  corpus: { pages: pages.length, distinct_words: grams[1].size },
  lexicon: { concepts: all.length, terms: terms.length },
  note: 'An English term with 0 occurrences in a Hebraic-register corpus is the bridge working, not a defect. Judgement is per concept.',
  totals: {
    reachable: group('REACHABLE').length,
    misspelled_dominant: group('MISSPELLED-DOMINANT').length,
    misspelled: group('MISSPELLED').length,
    uncovered: group('UNCOVERED').length,
  },
  concepts: all,
};
writeFileSync(new URL('./results/lexicon-audit.json', import.meta.url), JSON.stringify(out, null, 2));

const w = (s, n) => String(s).padEnd(n);
console.log(`corpus ${pages.length} pages, ${grams[1].size} distinct words`);
console.log(`lexicon ${all.length} concepts, ${terms.length} terms\n`);
console.log(`  REACHABLE            ${out.totals.reachable}`);
console.log(`  MISSPELLED-DOMINANT  ${out.totals.misspelled_dominant}  reachable, but the corpus's usual spelling is unlisted`);
console.log(`  MISSPELLED           ${out.totals.misspelled}  unreachable, and a near spelling IS in the corpus`);
console.log(`  UNCOVERED            ${out.totals.uncovered}  unreachable, nothing resembles it\n`);

for (const s of ['MISSPELLED', 'MISSPELLED-DOMINANT']) {
  const g = group(s);
  if (!g.length) continue;
  console.log(`${s}:`);
  for (const c of g) {
    console.log(`  ${w(c.concept, 16)} lexicon lists: ${c.corpus_forms.join(', ') || '(nothing in corpus)'}`);
    console.log(`  ${w('', 16)} corpus also writes: `
      + c.unlisted_spellings.map((u) => `${u.form} (${u.pages}p/${u.hits}h)`).join(', '));
  }
  console.log('');
}
console.log('UNCOVERED (lexicon may be correct — the corpus has no article):');
for (const c of group('UNCOVERED')) console.log(`  ${w(c.concept, 16)}${c.gloss}`);

await pool.end();
