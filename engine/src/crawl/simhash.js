// Near-duplicate detection (§9.6).
//
// "Necessary because syndicated Jubilee articles appear on multiple network
// domains." That is the real case this exists for: the same teaching published
// on four Jubilee properties with a different footer on each. `content_hash`
// sees four documents; a reader sees one article filling four Zone A slots.
//
// SimHash rather than MinHash, because the storage is a single 64-bit integer
// and the candidate lookup is four equality probes (see migration 013), where
// MinHash wants a signature of dozens of values. At this corpus size the
// accuracy difference does not pay for the storage difference.

import { createHash } from 'node:crypto';

const BITS = 64;
const SHINGLE_WORDS = 4;

/**
 * 64-bit SimHash over word shingles.
 *
 * Shingles of four words, not single words: a bag of words says two articles on
 * forgiveness are the same document, and on a corpus that is entirely articles
 * about a few dozen themes that is the common case rather than the edge case.
 * Word order is most of the signal here.
 *
 * @returns {bigint} the hash, unsigned
 */
export function simhash(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 0n;

  const shingles = new Map();
  const count = Math.max(1, words.length - SHINGLE_WORDS + 1);
  for (let i = 0; i < count; i++) {
    const shingle = words.slice(i, i + SHINGLE_WORDS).join(' ');
    // Repeated boilerplate ("read more", a repeated call to action) would
    // otherwise dominate a short page. Weighting by occurrence but capping at 3
    // keeps a genuinely repeated phrase meaningful without letting a footer vote
    // fifty times.
    shingles.set(shingle, Math.min((shingles.get(shingle) ?? 0) + 1, 3));
  }

  const vector = new Array(BITS).fill(0);
  for (const [shingle, weight] of shingles) {
    const h = hash64(shingle);
    for (let bit = 0; bit < BITS; bit++) {
      const set = (h >> BigInt(bit)) & 1n;
      vector[bit] += set ? weight : -weight;
    }
  }

  let out = 0n;
  for (let bit = 0; bit < BITS; bit++) {
    if (vector[bit] > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

// The first 8 bytes of a SHA-256. Not the fastest choice, but it is in the
// standard library, it is well distributed, and the cost is trivial beside the
// fetch that produced the text.
function hash64(value) {
  const digest = createHash('sha256').update(value).digest();
  return digest.readBigUInt64BE(0);
}

export function hammingDistance(a, b) {
  let x = BigInt(a) ^ BigInt(b);
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
}

/**
 * Split into the four 16-bit bands migration 013 indexes.
 *
 * The pigeonhole argument: two hashes within a Hamming distance of 3 have at
 * most 3 differing bits spread across 4 bands, so at least one band is
 * identical. Probing all four bands therefore finds every true near-duplicate,
 * and nothing further than distance 3 is guaranteed to be found -- which is why
 * `near_duplicate_max_distance` above 3 is documented as breaking the index
 * rather than as a knob to turn.
 */
export function bands(hash) {
  const h = BigInt(hash);
  return [
    Number((h >> 48n) & 0xffffn),
    Number((h >> 32n) & 0xffffn),
    Number((h >> 16n) & 0xffffn),
    Number(h & 0xffffn),
  ];
}

// Postgres BIGINT is signed; a SimHash is not. Values above 2^63 come back as
// negative and must go in as negative. The bit pattern is what matters and it is
// preserved in both directions.
export function toSigned(hash) {
  const h = BigInt(hash) & 0xffffffffffffffffn;
  return h >= 0x8000000000000000n ? h - 0x10000000000000000n : h;
}

export const fromSigned = (value) => BigInt(value) & 0xffffffffffffffffn;

/**
 * Find the canonical page among a set of near-duplicates.
 *
 * §9.6 canonical preference order: "the page whose URL matches canonical_url,
 * then the T1 page, then the oldest first_seen_at."
 */
export function pickCanonical(candidates) {
  return [...candidates].sort((a, b) => {
    const selfCanonical = (p) => (p.canonical_url && p.canonical_url === p.url ? 0 : 1);
    if (selfCanonical(a) !== selfCanonical(b)) return selfCanonical(a) - selfCanonical(b);
    const tierRank = (p) => (p.tier === 'T1' ? 0 : p.tier === 'T2' ? 1 : 2);
    if (tierRank(a) !== tierRank(b)) return tierRank(a) - tierRank(b);
    const seen = (p) => new Date(p.first_seen_at ?? 0).getTime();
    if (seen(a) !== seen(b)) return seen(a) - seen(b);
    return Number(a.id) - Number(b.id);
  })[0];
}

/**
 * Look up near-duplicates of a hash, using the band index.
 * Returns candidates already inside the distance threshold.
 */
export async function findNearDuplicates(db, hash, { excludePageId = null, maxDistance = 3 } = {}) {
  const [b0, b1, b2, b3] = bands(hash);
  const signed = toSigned(hash);

  const { rows } = await db.query(
    `SELECT id, url, canonical_url, tier, first_seen_at, simhash,
            simhash_distance(simhash, $1) AS distance
       FROM pages
      WHERE status = 'indexed'
        AND simhash IS NOT NULL
        AND ($6::bigint IS NULL OR id <> $6)
        AND (simhash_b0 = $2 OR simhash_b1 = $3 OR simhash_b2 = $4 OR simhash_b3 = $5)
        AND simhash_distance(simhash, $1) <= $7
      ORDER BY distance
      LIMIT 20`,
    [signed.toString(), b0, b1, b2, b3, excludePageId, maxDistance]);

  return rows;
}
