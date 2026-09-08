// Rate limiting (§14).
//
// "60 searches per minute per IP anonymous, 300 per minute for authenticated
// Jubilee ID sessions. Returns 429 with Retry-After."
//
// This is a per-instance sliding window held in memory. Say plainly what that
// means: with N API instances behind the tunnel, the effective ceiling is N x 60,
// because no instance knows what the others have served.
//
// That is the right trade at this scale and the wrong one later. The limit here
// exists to stop a runaway script and a careless scraper, and it does that. It
// is not a defence against a distributed attack, which belongs at Cloudflare in
// front of the tunnel, where the request never reaches Node at all. When a
// shared counter is genuinely needed, the Postgres-first answer is an unlogged
// table keyed on the same bucket -- which costs a round trip on every search and
// should not be paid until it buys something.

const WINDOW_MS = 60_000;
const buckets = new Map();

export const LIMITS = { anonymous: 60, authenticated: 300 };

/**
 * @param {string} key       client IP, or the Jubilee ID when signed in
 * @param {number} limit
 * @returns {{allowed: boolean, remaining: number, retryAfter: number}}
 */
export function consume(key, limit) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let hits = buckets.get(key);
  if (!hits) { hits = []; buckets.set(key, hits); }

  // Drop everything older than the window. The array stays sorted because
  // timestamps only ever arrive in order.
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  if (i > 0) hits.splice(0, i);

  if (hits.length >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000)),
    };
  }

  hits.push(now);
  return { allowed: true, remaining: limit - hits.length, retryAfter: 0 };
}

// Without this the map grows one entry per distinct client, forever. Runs on a
// timer rather than on the request path, where it would be a per-request scan of
// every other client's bucket.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) buckets.delete(key);
  }
}, WINDOW_MS);
sweeper.unref();

export const bucketCount = () => buckets.size;
export const reset = () => buckets.clear();
