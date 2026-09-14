// What Hebrew vocabulary does the corpus use that the lexicon cannot bridge?
//
// D9's floor is a count — 60 to 100 concepts — but the value is coverage. Adding
// 14 arbitrary concepts to reach 60 satisfies the letter and bridges nothing.
// This proposes the 14 from what the corpus actually says, which turns the quota
// into a measurement.
//
// Method: Hebrew transliterations in this corpus are capitalised mid-sentence
// ("...the Ruach HaKodesh moved..."), where ordinary English words are not. So
// capitalised-not-at-sentence-start, seen on several pages, minus everything the
// lexicon already lists, minus English proper nouns — which are left in the
// output to be struck out by eye rather than guessed at by regex.

import { writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const unaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const { rows: terms } = await pool.query(
  `SELECT t.term, c.concept_key FROM lexicon_terms t
     JOIN lexicon_concepts c ON c.id = t.concept_id`);
const known = new Set();
for (const t of terms) {
  for (const w of unaccent(t.term.toLowerCase()).split(/[\s-]+/)) known.add(w);
}

const { rows: pages } = await pool.query(`
  SELECT source_path, title, COALESCE(body_text,'') AS body_text
  FROM pages WHERE source_path LIKE 'cdn:%' AND status = 'indexed'`);

// Capitalised, mid-sentence, with a LOWERCASE word on both sides. Requiring the
// follower to be lowercase is what excludes headings: this corpus is full of
// title-case headings ("Two Names That Are Sentences"), and without it they
// dominate the output with ordinary English words.
const MID = /(?<=[a-z,]\s)([A-Z][A-Za-z'’-]{2,})(?=[\s,;.]+[a-z])/g;

// Words that survive the pattern but are plainly English. Weekdays and months
// are capitalised everywhere and are the largest remaining source of noise.
const STOP = new Set(`monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
english hebrew greek aramaic latin god lord jesus christ bible scripture verse chapter
inspire jsv i'm i'll he'll she'll`.split(/\s+/));

const hits = new Map();
const lower = new Map();
for (const p of pages) {
  for (const m of p.body_text.matchAll(/\b[a-z][a-z'’-]{2,}\b/g)) {
    lower.set(m[0], (lower.get(m[0]) ?? 0) + 1);
  }
}
for (const p of pages) {
  const seen = new Set();
  for (const m of p.body_text.matchAll(MID)) {
    const raw = m[1];
    const key = unaccent(raw.toLowerCase()).replace(/[^a-z'-]/g, '');
    if (key.length < 3 || known.has(key) || STOP.has(key)) continue;
    if (!hits.has(key)) hits.set(key, { form: raw, hits: 0, pages: new Set(), examples: [] });
    const e = hits.get(key);
    e.hits += 1;
    e.pages.add(p.source_path);
    if (!seen.has(key) && e.examples.length < 2) {
      const i = p.body_text.indexOf(raw);
      e.examples.push(p.body_text.slice(Math.max(0, i - 55), i + raw.length + 55).replace(/\s+/g, ' ').trim());
      seen.add(key);
    }
  }
}

// A transliteration is capitalised nearly always; an English word that slipped
// through is not. The ratio separates them without needing a dictionary.
const ranked = [...hits.entries()]
  .map(([key, e]) => ({
    key, form: e.form, hits: e.hits, pages: e.pages.size,
    lowercase: lower.get(key) ?? 0,
    always_capitalised: (lower.get(key) ?? 0) <= e.hits * 0.15,
    examples: e.examples,
  }))
  .filter((e) => e.pages >= 4 && e.always_capitalised)
  .sort((a, b) => b.pages - a.pages);

writeFileSync(new URL('./results/lexicon-candidates.json', import.meta.url),
  JSON.stringify({ ran_at: new Date().toISOString(), candidates: ranked }, null, 2));

const w = (s, n) => String(s).padEnd(n);
console.log(`${ranked.length} capitalised mid-sentence forms on 4+ pages, not in the lexicon\n`);
console.log(`  ${w('form', 20)}${w('pages', 8)}${w('hits', 7)}example`);
for (const e of ranked.slice(0, 60)) {
  console.log(`  ${w(e.form, 20)}${w(e.pages, 8)}${w(e.hits, 7)}${(e.examples[0] ?? '').slice(0, 78)}`);
}

await pool.end();
