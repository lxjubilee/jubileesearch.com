// The Hebrew article rule, §13.3.
//
// "Stored surface forms use 'Ruach HaKodesh' or 'the Ruach Kodesh'. The admin
// console rejects any term entry that would produce a doubled article. This is
// a validation rule in the lexicon editor, not a style suggestion."
//
// The rule lives in the database as the CHECK constraint
// `lexicon_terms_no_doubled_article`, backed by `has_doubled_hebrew_article()`
// in migration 004. That is the enforcement point and it cannot be bypassed by
// an API that forgets to validate.
//
// This file holds a JavaScript transcription of the same pattern so the rule can
// be tested without a database, and asserts that the two agree by reading the
// roots list straight out of the migration. If somebody adds a root to the
// migration and not here, the last test in this file fails.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '004_lexicon.sql'),
  'utf8');

// Pull the alternation out of the dollar-quoted literal in the migration.
const rootsFromMigration = migration.match(/\$roots\$(.+?)\$roots\$/s)?.[1];

// Postgres spells the word boundaries \m (start) and \M (end); JavaScript spells
// both \b. Otherwise the pattern is character for character the one in 004.
const doubledArticle = new RegExp(
  String.raw`\bthe\b\s+(\S+\s+)?ha-?(${rootsFromMigration})`, 'i');

const hasDoubledArticle = (term) => doubledArticle.test(term);

describe('lexicon: doubled Hebrew article', () => {
  test('the migration still defines the roots list this test reads', () => {
    assert.ok(rootsFromMigration, 'could not find the $roots$ literal in 004_lexicon.sql');
    assert.ok(rootsFromMigration.includes('kodesh'));
    assert.ok(rootsFromMigration.includes('mashiach'));
  });

  // The forms the house style permits.
  for (const term of ['ruach hakodesh', 'ruach ha-kodesh', 'ruach kodesh', 'hamashiach',
                      'mashiach', 'the ruach kodesh', 'holy spirit']) {
    test(`allows "${term}"`, () => assert.equal(hasDoubledArticle(term), false));
  }

  // The doubling: "the" plus the Hebrew Ha- prefix on the same phrase.
  for (const term of ['the ruach hakodesh', 'the ruach ha-kodesh', 'the hamashiach',
                      'the hatorah', 'THE Ruach HaKodesh']) {
    test(`rejects "${term}"`, () => assert.equal(hasDoubledArticle(term), true));
  }

  // The reason the rule is a roots list and not a bare /the\s+ha/: these are
  // ordinary English and must not be caught.
  for (const term of ['the harvest', 'the hallel', 'the habit', 'the handmaid',
                      'the haggadah', 'the hand of god']) {
    test(`does not catch "${term}"`, () => assert.equal(hasDoubledArticle(term), false));
  }

  test('every term in the starter seed passes the constraint', () => {
    const seed = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '023_seed_lexicon.sql'),
      'utf8');
    const block = seed.slice(seed.indexOf('WITH term_data'));
    const terms = [...block.matchAll(/^\s*\('[a-z_]+','([^']+)'/gm)].map((m) => m[1]);

    assert.ok(terms.length > 150, `only found ${terms.length} terms; the parser has drifted`);
    const offenders = terms.filter(hasDoubledArticle);
    assert.deepEqual(offenders, [], 'migration 023 would be rejected by the constraint in 004');
  });
});

export { hasDoubledArticle };
