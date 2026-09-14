// The 14 concepts D9 is short, chosen by measurement rather than to reach 60.
//
// The candidate scan found one dominant class: this corpus writes biblical
// proper nouns in BOTH registers, often in different articles — "Moses" on 27
// pages, "Mosheh" on 36, "Moshe" on 49. A reader who types Moses cannot reach
// the article that says Mosheh, and vice versa. That is acceptance criterion 8's
// exact failure mode, on the corpus's most frequent vocabulary, and the lexicon
// currently contains not one of these pairs.
//
// `bridged_pages` is the number that matters: pages carrying ONE register and
// not the other. Those are the pages a query in the wrong register cannot reach
// today, and the number of them a concept would recover.

import { writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const PROPOSED = [
  ['israel',      'Israel, the people and the land.',        ['yisrael', "yisra'el"], ['israel']],
  ['moshe',       'Moses.',                                  ['moshe', 'mosheh'],     ['moses']],
  ['yeshayahu',   'The prophet Isaiah, and the book.',       ['yeshayahu'],           ['isaiah']],
  ['dawid',       'King David.',                             ['dawid'],               ['david']],
  ['mitsrayim',   'Egypt.',                                  ['mitsrayim', 'mitzrayim'], ['egypt']],
  ['yerushalayim','Jerusalem.',                              ['yerushalayim'],        ['jerusalem']],
  ['shaul',       'The apostle Paul, by his Hebrew name.',   ["sha'ul", 'shaul'],     ['paul']],
  ['avraham',     'Abraham, called Avram before the covenant.', ['avraham', 'avram'], ['abraham', 'abram']],
  ['yaakov',      'Jacob, renamed Israel.',                  ["ya'akov", "ya'aqov", 'yaakov'], ['jacob']],
  ['aharon',      'Aaron, the first high priest.',           ['aharon'],              ['aaron']],
  ['yehudah',     'Judah, the tribe and the kingdom.',       ['yehudah'],             ['judah']],
  ['yehoshua_bin_nun', 'Joshua son of Nun.',                 ['yehoshua'],            ['joshua']],
  ['yosef',       'Joseph.',                                 ['yosef'],               ['joseph']],
  ['yirmeyahu',   'The prophet Jeremiah, and the book.',     ['yirmeyahu'],           ['jeremiah']],
];

const RUNNERS_UP = [
  ['kefa', 'Peter.', ['kefa'], ['peter']],
  ['noach', 'Noah.', ['noach'], ['noah']],
  ['shemot', 'Exodus, the book.', ['shemot'], ['exodus']],
  ['devarim', 'Deuteronomy, the book.', ['devarim'], ['deuteronomy']],
  ['eliyahu', 'Elijah.', ['eliyahu'], ['elijah']],
  ['yitzchak', 'Isaac.', ['yitzchak', 'yitschak'], ['isaac']],
  ['iyov', 'Job, the man and the book.', ['iyov'], ['job']],
  ['tsion', 'Zion.', ['tsion', 'tziyon'], ['zion']],
  ['miryam', 'Miriam; also Mary.', ['miryam'], ['miriam', 'mary']],
  ['yochanan', 'John.', ['yochanan'], ['john']],
];

const unaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const { rows: pages } = await pool.query(`
  SELECT source_path, COALESCE(body_text,'') AS body_text
  FROM pages WHERE source_path LIKE 'cdn:%' AND status = 'indexed'`);

const words = pages.map((p) => ({
  path: p.source_path,
  set: new Set(unaccent(p.body_text.toLowerCase()).replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/)),
}));

function score(hebrew, english) {
  let he = 0; let en = 0; let both = 0; let either = 0;
  for (const p of words) {
    const h = hebrew.some((t) => p.set.has(t));
    const e = english.some((t) => p.set.has(t));
    if (h && e) both += 1; else if (h) he += 1; else if (e) en += 1;
    if (h || e) either += 1;
  }
  // Pages carrying exactly one register: unreachable from the other today.
  return { pages_total: either, hebrew_only: he, english_only: en, both, bridged_pages: he + en };
}

const rank = (list) => list.map(([key, gloss, hebrew, english]) => ({
  concept_key: key, gloss, hebrew, english, ...score(hebrew, english),
})).sort((a, b) => b.bridged_pages - a.bridged_pages);

const proposed = rank(PROPOSED);
const runners = rank(RUNNERS_UP);

writeFileSync(new URL('./results/lexicon-proposal.json', import.meta.url),
  JSON.stringify({ ran_at: new Date().toISOString(), proposed, runners_up: runners }, null, 2));

const w = (s, n) => String(s).padEnd(n);
const show = (title, list) => {
  console.log(`\n${title}`);
  console.log(`  ${w('concept', 20)}${w('hebrew', 22)}${w('english', 12)}${w('he-only', 9)}${w('en-only', 9)}${w('both', 6)}bridges`);
  let total = 0;
  for (const r of list) {
    total += r.bridged_pages;
    console.log(`  ${w(r.concept_key, 20)}${w(r.hebrew.join('/'), 22)}${w(r.english.join('/'), 12)}`
      + `${w(r.hebrew_only, 9)}${w(r.english_only, 9)}${w(r.both, 6)}${r.bridged_pages}`);
  }
  console.log(`  ${w('', 20)}${w('', 22)}${w('', 12)}${w('', 9)}${w('', 9)}${w('', 6)}${total} pages`);
};
show('PROPOSED — the 14 that close D9 by measurement', proposed);
show('RUNNERS-UP — if the count matters more than the ceiling', runners);

await pool.end();
