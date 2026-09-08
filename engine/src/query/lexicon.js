// Lexicon expansion (R2, §13.3).
//
// This is what makes acceptance criterion 8 pass: "a query for 'Holy Spirit'
// returns pages that use only 'Ruach HaKodesh', and the reverse. Zero failures
// on the 20 cross-register pairs."
//
// §13.3 is explicit that expansion applies to the *lexical* path only: "The
// vector path already bridges much of this semantically, and double-expanding it
// degrades precision." Nothing here touches the embedding.

import { tokenize } from '../text/normalize.js';

// Appendix A.2, with one addition. The spec's query returns sibling terms; this
// one also returns the concept id, because §13.3 step 5 requires the matched
// concepts to be written to search_queries.expanded_concepts for tuning, and
// running a second query to recover them would be wasteful.
const EXPANSION_SQL = `
  SELECT DISTINCT t2.term, t2.weight, c.id AS concept_id, c.concept_key
  FROM lexicon_terms t1
  JOIN lexicon_concepts c ON c.id = t1.concept_id AND c.active
  JOIN lexicon_terms t2 ON t2.concept_id = t1.concept_id
  WHERE t1.term = ANY($1::text[])
    AND (t2.lang = $2 OR t2.lang = 'en')
    AND t2.term <> t1.term`;

/**
 * @param {import('pg').Pool} db
 * @param {string} normalized  the fully-stripped query
 * @param {string} lang
 * @param {object} cfg  ranking config
 */
export async function expand(db, normalized, lang, cfg) {
  const tokens = tokenize(normalized);
  if (tokens.length === 0) return empty();

  const { rows } = await db.query(EXPANSION_SQL, [tokens, lang]);
  if (rows.length === 0) return empty();

  // A term already present in the query is not an expansion of it. Without this
  // check, "holy spirit" would re-add "holy spirit" in a weighted group and
  // double-count it against itself.
  const present = new Set(tokens);
  const concepts = new Map();
  const byWeight = new Map();

  for (const row of rows) {
    if (present.has(row.term)) continue;
    concepts.set(Number(row.concept_id), row.concept_key);

    // The column default is 1.00; §13.3 step 4 says expanded terms carry "their
    // configured weight (default 0.60)". A term that was never given a weight
    // therefore takes the configured expansion default, not full weight -- an
    // unweighted synonym must not compete with the words the user actually typed.
    const raw = row.weight === null ? cfg.lexicon_expansion_weight : Number(row.weight);
    const bucket = Math.round(Math.min(raw, 1) * 10) / 10;
    if (!byWeight.has(bucket)) byWeight.set(bucket, []);
    byWeight.get(bucket).push(row.term);
  }

  if (concepts.size === 0) return empty();

  return {
    conceptIds: [...concepts.keys()],
    conceptKeys: [...concepts.values()],
    // Descending so the strongest synonyms are the first group, which makes a
    // debug=true payload readable top to bottom.
    groups: [...byWeight.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([weight, terms]) => ({ weight, terms: [...new Set(terms)].sort() })),
  };
}

const empty = () => ({ conceptIds: [], conceptKeys: [], groups: [] });

// ---------------------------------------------------------------------------
// tsquery construction.
//
// Appendix A.1 passes one already-expanded string to websearch_to_tsquery, which
// is the right shape but throws the weights away -- every expansion would count
// as much as the user's own words. §13.3 step 4 requires "the original terms at
// full weight and expanded terms at their configured weight", so the lexical
// score is instead
//
//     ts_rank_cd(tsv, original) + Σ weight_i * ts_rank_cd(tsv, group_i)
//
// with one group per distinct weight. Two or three groups in practice.
//
// Terms are our own editorial data, not user input, but they are still
// sanitised here rather than trusted: a stray apostrophe or ampersand in a
// lexicon row would make to_tsquery raise a syntax error and take down every
// query that touched that concept. Stripping is the failure mode that degrades
// instead of breaking.
// ---------------------------------------------------------------------------

const sanitize = (term) =>
  term.replace(/[^\p{L}\p{N}\p{M}\s-]/gu, ' ').trim().split(/\s+/).filter(Boolean);

/** One tsquery string for a group of terms: phrases stay phrases, groups OR. */
export function groupToTsquery(terms) {
  const clauses = [];
  for (const term of terms) {
    const words = sanitize(term);
    if (words.length === 0) continue;
    // `<->` keeps "holy spirit" a phrase. Without it the group would match any
    // page containing "holy" anywhere and "spirit" anywhere, which on a ministry
    // corpus is every page.
    clauses.push(words.length === 1 ? words[0] : `(${words.join(' <-> ')})`);
  }
  return clauses.join(' | ');
}
