// JWT verification against a JWKS (RFC 7515, RFC 7517).
//
// The second of the two ways this engine can be told who a bearer token belongs
// to. `auth.js` prefers RFC 7662 token introspection where the SSO offers it,
// because introspection is authoritative: it answers "is this token still
// valid *right now*", which a signature check cannot. A revoked token verifies
// perfectly well until it expires.
//
// But plenty of OIDC providers do not expose introspection to a client, and
// asking the authority on every request costs a network round trip inside a
// §13.10 latency budget that allows 15 ms for the whole pre-retrieval stage. So
// when only a JWKS is published, this verifies locally.
//
// No dependency: node:crypto has imported JWKs directly since Node 15, and the
// verification is a signature check plus four claim checks. A JWT library would
// be a supply-chain risk on the one code path where a mistake means admitting a
// forged identity.

import { createPublicKey, verify as verifySignature } from 'node:crypto';

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache = null;

// Only asymmetric algorithms. HS256 is deliberately absent: a JWT library that
// accepts it alongside RS256 is how the classic algorithm-confusion forgery
// works -- an attacker signs with the *public* key as an HMAC secret and a
// naive verifier accepts it. There is no shared secret here to confuse it with.
const ALGORITHMS = {
  RS256: { hash: 'sha256', options: {} },
  RS384: { hash: 'sha384', options: {} },
  RS512: { hash: 'sha512', options: {} },
  PS256: { hash: 'sha256', options: { padding: 1 << 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 } },
  ES256: { hash: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
};

async function getJwks(url) {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`JWKS endpoint returned ${res.status}`);
    const doc = await res.json();
    const keys = Array.isArray(doc?.keys) ? doc.keys : [];
    if (keys.length === 0) throw new Error('JWKS document contained no keys');
    jwksCache = { url, at: Date.now(), keys };
    return keys;
  } finally {
    clearTimeout(timer);
  }
}

/** Force a refetch. Called once when a `kid` is unknown, in case keys rotated. */
export const invalidateJwks = () => { jwksCache = null; };

const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

/**
 * Verify a JWT and return its claims, or null.
 *
 * Null for every failure, without distinguishing between them to the caller: a
 * bad signature, an expired token and a wrong audience are all "not
 * authenticated", and telling a caller which one it was is a probing oracle.
 * The reason is logged, not returned.
 *
 * @param {string} token
 * @param {{jwksUri: string, issuer?: string, audience?: string}} options
 */
export async function verifyJwt(token, { jwksUri, issuer, audience }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return fail('not a three-part JWT');

  let header;
  let claims;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return fail('header or payload is not base64url JSON');
  }

  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) return fail(`unsupported or unsafe alg: ${header.alg}`);

  let keys;
  try {
    keys = await getJwks(jwksUri);
  } catch (err) {
    return fail(`could not load JWKS: ${err.message}`);
  }

  let jwk = pickKey(keys, header.kid);
  if (!jwk) {
    // A `kid` that is not in the cached set is the normal signal that the
    // authority rotated its keys. One refetch, then give up.
    invalidateJwks();
    try {
      jwk = pickKey(await getJwks(jwksUri), header.kid);
    } catch { /* handled below */ }
    if (!jwk) return fail(`no key in the JWKS matches kid ${header.kid}`);
  }

  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    return fail(`JWKS key could not be imported: ${err.message}`);
  }

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');

  let ok = false;
  try {
    ok = verifySignature(algorithm.hash, signed, { key, ...algorithm.options }, signature);
  } catch (err) {
    return fail(`signature check threw: ${err.message}`);
  }
  if (!ok) return fail('signature does not verify');

  // --- claims ---------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;   // a minute of clock drift between here and the authority

  if (typeof claims.exp === 'number' && claims.exp + skew < now) return fail('token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) return fail('token is not yet valid');
  if (issuer && claims.iss !== issuer) return fail(`issuer ${claims.iss} is not ${issuer}`);

  if (audience) {
    // `aud` is a string or an array of strings, per RFC 7519.
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return fail(`audience ${claims.aud} does not include ${audience}`);
  }

  return claims;
}

function pickKey(keys, kid) {
  // A JWKS with exactly one signing key and a token with no `kid` is common and
  // unambiguous. More than one key and no `kid` is not, and guessing would mean
  // trying each until one verifies -- which is how a key intended for
  // encryption ends up validating a signature.
  const signing = keys.filter((k) => !k.use || k.use === 'sig');
  if (kid) return signing.find((k) => k.kid === kid) ?? null;
  return signing.length === 1 ? signing[0] : null;
}

function fail(reason) {
  console.warn(JSON.stringify({ level: 'warn', at: 'auth.jwt', msg: `token rejected: ${reason}` }));
  return null;
}
