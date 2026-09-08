// Intent router (R3, §13.2).
//
// "Classification happens before retrieval. Cheap deterministic rules first,
// small classifier only as fallback." Everything here is deterministic; no
// classifier is called. The fallback the spec allows has not been needed,
// because the five intents are separated by structure rather than by meaning:
// a reference parses or it does not, an alias matches or it does not, a
// question starts with an interrogative or it does not.
//
// Order matters and is not arbitrary. Scripture wins over everything because a
// reference is unambiguous when it parses at all. Navigational comes next,
// because someone typing a site name wants that site, not an essay about it.
// Entity, then the two retrieval intents.

import { parseReference } from '../text/scripture.js';

const INTERROGATIVES = {
  en: ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'can', 'should',
       'is', 'are', 'do', 'does', 'did', 'will', 'would'],
  ro: ['ce', 'de ce', 'cum', 'cand', 'unde', 'cine', 'care', 'pot', 'este', 'sunt'],
  hi: ['kya', 'kyon', 'kaise', 'kab', 'kahan', 'kaun'],
};

/**
 * Deterministic part of the router. No I/O, so it is the part under test.
 *
 * @param {{normalized: string, routable: string}} q  from normalize()
 * @param {string} lang
 * @param {{navigational?: object|null, entity?: object|null}} matches
 *        Results of the two lookups that do need the database, resolved by the
 *        caller. Passing them in rather than querying here keeps this module
 *        pure and keeps the two round trips concurrent with the cache check.
 */
export function classify(q, lang, matches = {}) {
  const scripture = parseReference(q.routable);
  if (scripture) return { intent: 'scripture', scripture };

  if (matches.navigational) return { intent: 'navigational', domain: matches.navigational };
  if (matches.entity) return { intent: 'entity', entity: matches.entity };

  const words = q.normalized.split(' ').filter(Boolean);
  if (isConversational(words, lang)) return { intent: 'conversational' };

  return { intent: 'topical' };
}

// "Natural-language question form detected by leading interrogative plus length"
// (§13.2). Both halves are needed. "who is yeshua" is a question; "who" alone is
// a fragment, and "grace" is a topic however long you stare at it.
//
// The length floor is three words: a two-word "why suffering" reads as a topic
// and gets better results from the topical path, where lexical weighting is not
// reduced.
function isConversational(words, lang) {
  if (words.length < 3) return false;
  const heads = INTERROGATIVES[lang] ?? INTERROGATIVES.en;
  const first = words[0];
  const firstTwo = `${words[0]} ${words[1]}`;
  // Romanian "de ce" is two words and must be checked as a phrase, otherwise
  // "de" alone would never match and every Romanian "why" question would route
  // to topical.
  return heads.includes(first) || heads.includes(firstTwo);
}

// The conversational intent's whole effect on retrieval: "semantic weighting
// increased and lexical weighting reduced" (§13.2). Expressed as a pair of
// multipliers on the two RRF contributions rather than as a branch in the
// retrieval code, so there is one place to tune it.
export function fusionWeights(intent) {
  switch (intent) {
    case 'conversational':
      // A paraphrased question shares few keywords with its answer -- acceptance
      // criterion 10 is exactly this case. Lean on the vectors.
      return { lexical: 0.6, semantic: 1.4 };
    case 'navigational':
      // The user typed a name. Names are lexical.
      return { lexical: 1.4, semantic: 0.6 };
    default:
      return { lexical: 1.0, semantic: 1.0 };
  }
}

// §13.7: navigational and entity queries cache for 60 minutes, everything else
// for 15. A best-bet hit or a debug flag bypasses the cache entirely, which is
// decided by the caller because it is not a property of the intent.
export function cacheTtlSeconds(intent, cfg) {
  return intent === 'navigational' || intent === 'entity'
    ? cfg.cache_ttl_navigational_s
    : cfg.cache_ttl_topical_s;
}
