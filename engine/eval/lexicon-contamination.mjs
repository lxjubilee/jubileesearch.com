// Which English surface forms also name a person in the stories?
//
// The corpus is narrative: every one of the 600 articles carries a `characters`
// frontmatter list, 1,149 distinct names between them. So an English term like
// "Paul" is ambiguous in a way its Hebrew counterpart "Sha'ul" is not — a query
// about a character named Paul would expand into the apostle's articles and pull
// them in as if they were relevant.
//
// The bridge should therefore be asymmetric, which `lexicon_terms.weight` already
// expresses per term: Hebrew -> English at full weight, English -> Hebrew reduced
// where the English form is also a person in the corpus.
//
// This decides membership of that reduced set by evidence rather than by guess.

import { writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';

// The English side of the 14 proposed concepts (see lexicon-proposal.mjs).
const PROPOSED_EN = {
  israel: ['israel'], moshe: ['moses'], yeshayahu: ['isaiah'], dawid: ['david'],
  mitsrayim: ['egypt'], yerushalayim: ['jerusalem'], shaul: ['paul'],
  avraham: ['abraham', 'abram'], yaakov: ['jacob'], aharon: ['aaron'],
  yehudah: ['judah'], yehoshua_bin_nun: ['joshua'], yosef: ['joseph'],
  yirmeyahu: ['jeremiah'],
};

const { rows: pages } = await pool.query(
  `SELECT characters FROM pages WHERE source_path LIKE 'cdn:%' AND status = 'indexed'`);

// Given names and surnames alike: a surname "Jacobs" does not collide, but a
// surname "Judah" does, and both are how a reader might refer to a person.
const nameParts = new Map();
for (const p of pages) {
  for (const full of p.characters ?? []) {
    for (const part of String(full).toLowerCase().replace(/[^a-z'\s-]/g, '').split(/[\s-]+/)) {
      if (part.length < 3) continue;
      if (!nameParts.has(part)) nameParts.set(part, new Set());
      nameParts.get(part).add(full);
    }
  }
}

// Existing lexicon English terms too — the instruction is "any other English
// surface form that also names a corpus character", not only the new fourteen.
const { rows: existing } = await pool.query(`
  SELECT t.term, t.lang, t.register, t.weight, c.concept_key
  FROM lexicon_terms t JOIN lexicon_concepts c ON c.id = t.concept_id
  WHERE t.lang = 'en' AND t.register <> 'OHI'`);

const check = (concept, term, source) => {
  const hits = nameParts.get(term.toLowerCase());
  return hits
    ? { concept, term, source, characters: [...hits].sort().slice(0, 6), n: hits.size }
    : null;
};

const found = [];
for (const [concept, terms] of Object.entries(PROPOSED_EN)) {
  for (const t of terms) { const r = check(concept, t, 'proposed'); if (r) found.push(r); }
}
for (const e of existing) {
  const r = check(e.concept_key, e.term, `existing (w=${e.weight})`);
  if (r) found.push(r);
}
found.sort((a, b) => b.n - a.n);

const clean = Object.entries(PROPOSED_EN)
  .filter(([c, ts]) => !ts.some((t) => nameParts.has(t)))
  .map(([c]) => c);

writeFileSync(new URL('./results/lexicon-contamination.json', import.meta.url),
  JSON.stringify({
    ran_at: new Date().toISOString(),
    corpus: { pages: pages.length, distinct_names: new Set(pages.flatMap((p) => p.characters ?? [])).size },
    contaminated: found, uncontaminated_proposed: clean,
  }, null, 2));

const w = (s, n) => String(s).padEnd(n);
console.log(`${pages.length} pages, ${nameParts.size} distinct name parts\n`);
console.log('CONTAMINATED — English surface form is also a character name:');
console.log(`  ${w('concept', 20)}${w('term', 12)}${w('source', 18)}${w('#', 4)}characters`);
for (const f of found) {
  console.log(`  ${w(f.concept, 20)}${w(f.term, 12)}${w(f.source, 18)}${w(f.n, 4)}${f.characters.join(', ')}`);
}
console.log(`\nUNCONTAMINATED of the 14 — stay symmetric at 1.00:\n  ${clean.join(', ')}`);

await pool.end();
