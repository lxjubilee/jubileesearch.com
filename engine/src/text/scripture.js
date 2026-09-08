// Scripture reference detection for the intent router (R3, §13.2).
//
// "Regex for book, chapter, and optional verse in English, Romanian, and Hebrew
// transliteration, matched against a canonical book-name table with
// abbreviations."
//
// The governing constraint is the last line of §13.2: "If the passage cannot be
// retrieved with certainty, the card is not rendered at all and the query falls
// through to normal results. Silence is correct; a wrong verse is not." So this
// parser is deliberately conservative. Every ambiguity resolves to null, and a
// null costs nothing -- the query simply gets ordinary two-zone results.
//
// The table lives in code rather than in a table of its own because the intent
// router runs inside a 15 ms budget (§13.10) shared with normalisation and
// lexicon expansion, and this is fixed reference data, not editorial content
// somebody will want to edit in the admin console.

// key, then surface forms: English (name and abbreviations), Romanian, and
// Hebrew transliteration where the book has one in common use. All lowercase
// and unaccented, matching what normalize() produces.
const BOOKS = [
  ['genesis',        ['genesis', 'gen', 'ge', 'gn'], ['geneza', 'facerea'], ['bereshit']],
  ['exodus',         ['exodus', 'exod', 'exo', 'ex'], ['exodul', 'iesirea'], ['shemot']],
  ['leviticus',      ['leviticus', 'lev', 'le', 'lv'], ['leviticul'], ['vayikra']],
  ['numbers',        ['numbers', 'num', 'nu', 'nm', 'nb'], ['numeri'], ['bamidbar']],
  ['deuteronomy',    ['deuteronomy', 'deut', 'deu', 'dt'], ['deuteronomul'], ['devarim']],
  ['joshua',         ['joshua', 'josh', 'jos', 'jsh'], ['iosua'], ['yehoshua']],
  ['judges',         ['judges', 'judg', 'jdg', 'jg'], ['judecatori'], ['shoftim']],
  ['ruth',           ['ruth', 'rth', 'ru'], ['rut'], ['rut']],
  ['1 samuel',       ['1 samuel', '1 sam', '1 sa', '1sam', '1sa'], ['1 samuel'], ['shmuel alef']],
  ['2 samuel',       ['2 samuel', '2 sam', '2 sa', '2sam', '2sa'], ['2 samuel'], ['shmuel bet']],
  ['1 kings',        ['1 kings', '1 kgs', '1 ki', '1kgs'], ['1 imparati', '1 regi'], ['melachim alef']],
  ['2 kings',        ['2 kings', '2 kgs', '2 ki', '2kgs'], ['2 imparati', '2 regi'], ['melachim bet']],
  ['1 chronicles',   ['1 chronicles', '1 chron', '1 chr', '1ch'], ['1 cronici'], ['divrei hayamim alef']],
  ['2 chronicles',   ['2 chronicles', '2 chron', '2 chr', '2ch'], ['2 cronici'], ['divrei hayamim bet']],
  ['ezra',           ['ezra', 'ezr', 'ez'], ['ezra'], ['ezra']],
  ['nehemiah',       ['nehemiah', 'neh', 'ne'], ['neemia'], ['nechemyah']],
  ['esther',         ['esther', 'esth', 'est', 'es'], ['estera'], ['ester']],
  ['job',            ['job', 'jb'], ['iov'], ['iyov']],
  ['psalms',         ['psalms', 'psalm', 'psa', 'ps', 'pss'], ['psalmii', 'psalmul', 'psalmi'], ['tehillim']],
  ['proverbs',       ['proverbs', 'prov', 'pro', 'prv', 'pr'], ['proverbe', 'proverbele'], ['mishlei']],
  ['ecclesiastes',   ['ecclesiastes', 'eccles', 'eccl', 'ecc', 'qoh'], ['eclesiastul'], ['kohelet']],
  ['song of songs',  ['song of songs', 'song of solomon', 'song', 'sos', 'canticles'], ['cantarea cantarilor'], ['shir hashirim']],
  ['isaiah',         ['isaiah', 'isa', 'is'], ['isaia'], ['yeshayahu']],
  ['jeremiah',       ['jeremiah', 'jer', 'je'], ['ieremia'], ['yirmeyahu']],
  ['lamentations',   ['lamentations', 'lam', 'la'], ['plangerile'], ['eichah']],
  ['ezekiel',        ['ezekiel', 'ezek', 'eze', 'ezk'], ['ezechiel'], ['yechezkel']],
  ['daniel',         ['daniel', 'dan', 'dn'], ['daniel'], ['daniyel']],
  ['hosea',          ['hosea', 'hos', 'ho'], ['osea'], ['hoshea']],
  ['joel',           ['joel', 'joe', 'jl'], ['ioel'], ['yoel']],
  ['amos',           ['amos', 'amo', 'am'], ['amos'], ['amos']],
  ['obadiah',        ['obadiah', 'obad', 'oba', 'ob'], ['obadia'], ['ovadyah']],
  ['jonah',          ['jonah', 'jon', 'jnh'], ['iona'], ['yonah']],
  ['micah',          ['micah', 'mic', 'mc'], ['mica'], ['michah']],
  ['nahum',          ['nahum', 'nah', 'na'], ['naum'], ['nachum']],
  ['habakkuk',       ['habakkuk', 'hab', 'hb'], ['habacuc'], ['chavakuk']],
  ['zephaniah',      ['zephaniah', 'zeph', 'zep', 'zp'], ['tefania'], ['tzefanyah']],
  ['haggai',         ['haggai', 'hag', 'hg'], ['hagai'], ['chaggai']],
  ['zechariah',      ['zechariah', 'zech', 'zec', 'zc'], ['zaharia'], ['zecharyah']],
  ['malachi',        ['malachi', 'mal', 'ml'], ['maleahi'], ['malachi']],
  ['matthew',        ['matthew', 'matt', 'mat', 'mt'], ['matei'], ['mattityahu']],
  ['mark',           ['mark', 'mrk', 'mk', 'mr'], ['marcu'], ['markos']],
  ['luke',           ['luke', 'luk', 'lk'], ['luca'], ['lukas']],
  ['john',           ['john', 'jhn', 'jn', 'joh'], ['ioan'], ['yochanan']],
  ['acts',           ['acts', 'act', 'ac'], ['faptele apostolilor', 'faptele'], ['maasei hashlichim']],
  ['romans',         ['romans', 'rom', 'ro', 'rm'], ['romani'], []],
  ['1 corinthians',  ['1 corinthians', '1 cor', '1 co', '1cor'], ['1 corinteni'], []],
  ['2 corinthians',  ['2 corinthians', '2 cor', '2 co', '2cor'], ['2 corinteni'], []],
  ['galatians',      ['galatians', 'gal', 'ga'], ['galateni'], []],
  ['ephesians',      ['ephesians', 'eph', 'ep'], ['efeseni'], []],
  ['philippians',    ['philippians', 'phil', 'php', 'pp'], ['filipeni'], []],
  ['colossians',     ['colossians', 'col', 'co'], ['coloseni'], []],
  ['1 thessalonians',['1 thessalonians', '1 thess', '1 th', '1thess'], ['1 tesaloniceni'], []],
  ['2 thessalonians',['2 thessalonians', '2 thess', '2 th', '2thess'], ['2 tesaloniceni'], []],
  ['1 timothy',      ['1 timothy', '1 tim', '1 ti', '1tim'], ['1 timotei'], []],
  ['2 timothy',      ['2 timothy', '2 tim', '2 ti', '2tim'], ['2 timotei'], []],
  ['titus',          ['titus', 'tit', 'ti'], ['tit'], []],
  ['philemon',       ['philemon', 'philem', 'phm', 'pm'], ['filimon'], []],
  ['hebrews',        ['hebrews', 'heb', 'hb'], ['evrei'], ['ivrim']],
  ['james',          ['james', 'jas', 'jm'], ['iacov'], ['yaakov']],
  ['1 peter',        ['1 peter', '1 pet', '1 pe', '1pet'], ['1 petru'], ['kefa alef']],
  ['2 peter',        ['2 peter', '2 pet', '2 pe', '2pet'], ['2 petru'], ['kefa bet']],
  ['1 john',         ['1 john', '1 jhn', '1 jn', '1jn'], ['1 ioan'], ['yochanan alef']],
  ['2 john',         ['2 john', '2 jhn', '2 jn', '2jn'], ['2 ioan'], ['yochanan bet']],
  ['3 john',         ['3 john', '3 jhn', '3 jn', '3jn'], ['3 ioan'], ['yochanan gimel']],
  ['jude',           ['jude', 'jud', 'jd'], ['iuda'], ['yehudah']],
  ['revelation',     ['revelation', 'revelations', 'rev', 're', 'apocalypse'], ['apocalipsa'], ['hitgalut']],
];

// Books with a single chapter. A bare "jude 3" is verse 3, not chapter 3, and
// getting that wrong is exactly the "wrong verse" the spec forbids.
const SINGLE_CHAPTER = new Set(['obadiah', 'philemon', '2 john', '3 john', 'jude']);

const CHAPTER_COUNTS = {
  genesis: 50, exodus: 40, leviticus: 27, numbers: 36, deuteronomy: 34, joshua: 24,
  judges: 21, ruth: 4, '1 samuel': 31, '2 samuel': 24, '1 kings': 22, '2 kings': 25,
  '1 chronicles': 29, '2 chronicles': 36, ezra: 10, nehemiah: 13, esther: 10, job: 42,
  psalms: 150, proverbs: 31, ecclesiastes: 12, 'song of songs': 8, isaiah: 66,
  jeremiah: 52, lamentations: 5, ezekiel: 48, daniel: 12, hosea: 14, joel: 3, amos: 9,
  obadiah: 1, jonah: 4, micah: 7, nahum: 3, habakkuk: 3, zephaniah: 3, haggai: 2,
  zechariah: 14, malachi: 4, matthew: 28, mark: 16, luke: 24, john: 21, acts: 28,
  romans: 16, '1 corinthians': 16, '2 corinthians': 13, galatians: 6, ephesians: 6,
  philippians: 4, colossians: 4, '1 thessalonians': 5, '2 thessalonians': 3,
  '1 timothy': 6, '2 timothy': 4, titus: 3, philemon: 1, hebrews: 13, james: 5,
  '1 peter': 5, '2 peter': 3, '1 john': 5, '2 john': 1, '3 john': 1, jude: 1,
  revelation: 22,
};

// surface form -> canonical key. Ordinals are folded here so "first john",
// "i john" and "1john" all land on the same row without three regexes.
const LOOKUP = new Map();
for (const [key, en, ro, he] of BOOKS) {
  for (const form of [...en, ...ro, ...he]) LOOKUP.set(form, key);
}

const ORDINALS = [
  [/\b(?:first|1st|i)\s+/g, '1 '],
  [/\b(?:second|2nd|ii)\s+/g, '2 '],
  [/\b(?:third|3rd|iii)\s+/g, '3 '],
];

// "1john" -> "1 john". Written as a separate pass so it cannot accidentally
// split a number out of a chapter reference.
const foldOrdinals = (s) => {
  let out = s;
  for (const [re, to] of ORDINALS) out = out.replace(re, to);
  return out.replace(/\b([123])(?=[a-z])/g, '$1 ');
};

// The longest book name is three words ("song of songs", "faptele apostolilor",
// "cantarea cantarilor", "divrei hayamim alef" is four). Try longest first so
// "song of songs 2" is not read as the book "song" at chapter... nothing.
const MAX_BOOK_WORDS = 4;

/**
 * Parse a scripture reference out of the *routable* form of a query -- the one
 * that still has its colons and hyphens.
 *
 * Returns null unless the whole query is a reference and nothing else. That
 * strictness is on purpose: "what does john 3:16 mean for my marriage" is a
 * question about a verse, not a request to be shown it, and answering it with a
 * verse card would be the engine talking over the reader.
 *
 * @returns {{book: string, chapter: number, verse: number|null, verseEnd: number|null, ref: string}|null}
 */
export function parseReference(routable) {
  if (!routable) return null;
  const text = foldOrdinals(routable.trim());

  // book, then chapter, then optionally :verse or :verse-verse.
  // A bare "john" with no chapter is not a reference -- it is a search for the
  // gospel, or for a person named John, and the router must not hijack it.
  const m = text.match(/^(.+?)\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\s*$/);
  if (!m) return parseSingleChapter(text);

  const [, bookPart, chapterStr, verseStr, verseEndStr] = m;
  const words = bookPart.trim().split(/\s+/);
  if (words.length > MAX_BOOK_WORDS) return null;

  const book = LOOKUP.get(words.join(' '));
  if (!book) return null;

  let chapter = Number(chapterStr);
  let verse = verseStr ? Number(verseStr) : null;
  const verseEnd = verseEndStr ? Number(verseEndStr) : null;

  // In a one-chapter book the bare number is the verse.
  if (SINGLE_CHAPTER.has(book) && verse === null) {
    verse = chapter;
    chapter = 1;
  }

  if (chapter < 1 || chapter > (CHAPTER_COUNTS[book] ?? 150)) return null;
  if (verse !== null && verse < 1) return null;
  if (verseEnd !== null && verseEnd <= verse) return null;

  return { book, chapter, verse, verseEnd, ref: format(book, chapter, verse, verseEnd) };
}

// "jude" alone, in a book that has only one chapter, is a whole-book reference.
function parseSingleChapter(text) {
  const book = LOOKUP.get(text.trim());
  if (!book || !SINGLE_CHAPTER.has(book)) return null;
  return { book, chapter: 1, verse: null, verseEnd: null, ref: format(book, 1, null, null) };
}

const TITLE_CASE = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function format(book, chapter, verse, verseEnd) {
  const name = TITLE_CASE(book);
  if (verse === null) return `${name} ${chapter}`;
  if (verseEnd === null) return `${name} ${chapter}:${verse}`;
  return `${name} ${chapter}:${verse}-${verseEnd}`;
}

export const canonicalBooks = () => BOOKS.map(([key]) => key);
