// Query normalisation, §13.1 step [1]: "trim, lowercase, unaccent, collapse
// whitespace, strip punctuation".
//
// Taken literally that breaks the very next stage. The intent router (§13.2)
// detects a scripture reference by matching book, chapter and optional verse --
// and "john 3:16" with punctuation stripped is "john 316", which no reference
// regex will ever recover. Acceptance criterion 16 requires the card to render
// for "a scripture-reference query in any supported form".
//
// So normalisation produces two strings from one input:
//
//   normalized  fully stripped. This is the lexical query, the lexicon lookup
//               key, and the cache key. It is also what goes into
//               search_queries.normalized, so the CTR rollup groups the same
//               question asked with different punctuation as one query.
//   routable    trimmed, lowercased, unaccented, whitespace collapsed, but with
//               reference punctuation (: . - ,) intact for the intent router.
//
// Both are lowercased and unaccented, so the two stages agree about everything
// except punctuation.

// Postgres `unaccent` works from a Latin-oriented rules file, and so does this.
// Restricting the strip to Latin-script characters is not an optimisation, it is
// correctness: NFD-decomposing Devanagari and then dropping combining marks
// would delete the vowel signs, which are letters, not accents. "हिन्दी" would
// come apart. Hebrew niqqud is the same story.
const unaccentLatin = (s) =>
  s.replace(/\p{Script=Latin}/gu, (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, ''));

// Anything that is not a letter, a number, or a mark becomes a space. \p{M} is
// kept so Devanagari matras and Hebrew points survive; they are part of the word.
const PUNCTUATION = /[^\p{L}\p{N}\p{M}]+/gu;
const REFERENCE_SAFE = /[^\p{L}\p{N}\p{M}:.,\-]+/gu;

export function normalize(raw) {
  const base = unaccentLatin(String(raw ?? '').trim().toLowerCase());
  return {
    raw: String(raw ?? '').trim(),
    normalized: base.replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim(),
    routable: base.replace(REFERENCE_SAFE, ' ').replace(/\s+/g, ' ').trim(),
  };
}

// Unigrams and bigrams, §13.3 step 1. Bigrams matter more than they look: the
// lexicon's highest-value entries are two words ("holy spirit", "ruach hakodesh",
// "day of atonement" is three but its bigrams still hit), and a unigram-only
// tokeniser would expand "holy" and "spirit" independently and find neither.
export function tokenize(normalized) {
  const words = normalized.split(' ').filter(Boolean);
  const out = new Set(words);
  for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
  for (let i = 0; i < words.length - 2; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return [...out];
}

// ---------------------------------------------------------------------------
// Language detection, §13.1 step [2].
//
// PLACEHOLDER. §6.1 specifies fasttext lid.176 or py3langid, and neither runs
// in-process here. What follows is a script-range check with a stopword tie-break
// -- enough to route en / ro / hi / he correctly on realistic queries, which is
// what the w_lang boost and the tsvector configuration actually need, and not
// enough for the 70-nation content §1 describes.
//
// It fails the way a heuristic fails: short queries with no stopword and no
// distinctive script fall back to the caller's hint, then to English. That is
// the honest behaviour -- guessing wrong sets the wrong tsvector dictionary and
// boosts the wrong pages.
//
// Replacing it means calling the Inference API or shelling out to a real model.
// Do that before Phase 3 sign-off if cross-language recall (acceptance 9) is
// measured on anything beyond these four languages.
// ---------------------------------------------------------------------------
const SCRIPTS = [
  [/\p{Script=Devanagari}/u, 'hi'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Cyrillic}/u, 'ru'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Han}/u, 'zh'],
];

const STOPWORDS = {
  ro: ['si', 'de', 'la', 'cu', 'ce', 'este', 'sunt', 'care', 'pentru', 'din', 'nu',
       'ca', 'lui', 'un', 'o', 'in', 'sa', 'se', 'mai', 'dumnezeu', 'cum'],
  en: ['the', 'and', 'of', 'is', 'are', 'what', 'why', 'how', 'for', 'from', 'not',
       'that', 'this', 'with', 'do', 'does', 'god', 'about'],
  es: ['el', 'los', 'las', 'una', 'que', 'por', 'para', 'como', 'dios', 'con'],
  fr: ['le', 'les', 'des', 'une', 'que', 'pour', 'dans', 'dieu', 'avec', 'est'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'gott', 'wie', 'was', 'mit'],
};

export function detectLanguage(normalized, hint = null) {
  const text = normalized ?? '';
  for (const [re, lang] of SCRIPTS) if (re.test(text)) return lang;

  const words = new Set(text.split(' ').filter(Boolean));
  let best = null;
  let bestScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const stop of stops) if (words.has(stop)) score++;
    // A tie goes to the earlier entry, which puts Romanian ahead of English --
    // deliberate, because the words they share ("nu", "o", "un") are Romanian
    // stopwords and English rarities.
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  if (best) return best;
  return hint ?? 'en';
}
