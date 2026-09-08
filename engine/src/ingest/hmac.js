// Publish-webhook authentication (§9.2, §17 Security).
//
// "Requests are authenticated by HMAC using a per-domain shared secret. Reject
// unsigned or stale requests (timestamp window of 5 minutes)."
//
// ---------------------------------------------------------------------------
// A note on the signature's shape, because §9.2's example is under-specified and
// this is the kind of gap that gets resolved differently by each publishing
// system and then never reconciled.
//
// The example payload carries `signature` as a field *inside* the JSON body.
// Signing a document that contains its own signature is circular, and it also
// gives no timestamp to enforce the five-minute window against. So the canonical
// scheme here is header-based:
//
//     X-Jubilee-Timestamp: <unix seconds>
//     X-Jubilee-Signature: sha256=<hex hmac of "<timestamp>.<raw body>">
//
// The raw body is signed, not a re-serialisation of it, so key ordering and
// whitespace cannot cause a mismatch between a Node sender and a PHP one.
//
// The in-body form from the spec's example is still accepted, for whichever
// systems D11 names that have already implemented it: the signed material is
// then the body with the `signature` key removed and the remaining keys sorted,
// and the timestamp comes from `issued_at`. It is a compatibility path, it is
// marked as such in the return value, and it should be retired once every
// publisher emits headers.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WINDOW_SECONDS = 300;

const sign = (secret, material) =>
  createHmac('sha256', secret).update(material).digest('hex');

// Never a plain === on a MAC. A byte-by-byte comparison that short-circuits
// leaks the correct prefix to anyone willing to time enough requests.
function equal(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * @param {object} input
 * @param {string} input.rawBody   the body exactly as received
 * @param {object} input.headers
 * @param {object} input.parsed    the parsed body
 * @param {string} input.secret    the domain's shared secret
 * @param {number} [input.now]     unix seconds, injectable for tests
 * @returns {{ok: true, scheme: string, signature: string} | {ok: false, error: string}}
 */
export function verifyWebhook({ rawBody, headers = {}, parsed = {}, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, error: 'no shared secret configured for this domain' };

  const headerSig = headers['x-jubilee-signature'];
  const headerTs = headers['x-jubilee-timestamp'];

  if (headerSig && headerTs) {
    const ts = Number(headerTs);
    if (!Number.isFinite(ts)) return { ok: false, error: 'malformed timestamp' };
    if (Math.abs(now - ts) > WINDOW_SECONDS) return { ok: false, error: 'stale request' };

    const expected = sign(secret, `${ts}.${rawBody}`);
    const provided = String(headerSig).replace(/^sha256=/, '');
    if (!equal(expected, provided)) return { ok: false, error: 'signature mismatch' };
    return { ok: true, scheme: 'header', signature: provided };
  }

  if (parsed.signature) {
    const ts = Number(parsed.issued_at ?? parsed.timestamp);
    if (!Number.isFinite(ts)) {
      // Without a timestamp the five-minute window cannot be enforced, and an
      // intercepted request would be replayable forever. That is not a
      // compatibility concession worth making.
      return { ok: false, error: 'in-body signature requires issued_at' };
    }
    if (Math.abs(now - ts) > WINDOW_SECONDS) return { ok: false, error: 'stale request' };

    const expected = sign(secret, canonicalize(parsed));
    if (!equal(expected, parsed.signature)) return { ok: false, error: 'signature mismatch' };
    return { ok: true, scheme: 'body', signature: parsed.signature };
  }

  return { ok: false, error: 'unsigned request' };
}

// Deterministic serialisation for the compatibility path: signature removed,
// keys sorted, no whitespace.
export function canonicalize(body) {
  const { signature, ...rest } = body;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Replay protection. A signature that has been seen inside the window is
 * refused; outside the window the timestamp check has already refused it, so
 * the table only ever has to hold five minutes of history.
 */
export async function consumeSignature(db, signature) {
  const { rowCount } = await db.query(
    `INSERT INTO webhook_nonces (signature) VALUES ($1)
     ON CONFLICT (signature) DO NOTHING`, [signature]);
  return rowCount === 1;
}

export const sweepNonces = (db) =>
  db.query(`DELETE FROM webhook_nonces WHERE seen_at < now() - interval '1 hour'`);

// Exported for the admin console's "show me what to sign" helper and for tests.
export const signPayload = (secret, timestamp, rawBody) => sign(secret, `${timestamp}.${rawBody}`);
