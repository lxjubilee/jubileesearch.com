// §8.2 ownership verification: the two proofs a domain owner can publish.
//
//   DNS TXT     jubilee-search-verification=<token>   on the host itself
//   well-known  https://<host>/.well-known/jubilee-search-<token>.txt
//               whose body contains the token
//
// "Because Zone A is a guaranteed placement rather than a scoring boost, this
// verification is the only thing standing between the network and an external
// site claiming premium real estate. Treat it as a security control, not a
// formality." So both checks are strict: exact token match, no redirects off
// the host for the well-known file, and a short timeout so a slow host cannot
// hold an admin request open.
//
// The resolver and the fetcher are injectable so the checks are unit-testable
// without a network; the defaults are Node's own.

import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';

export const TXT_PREFIX = 'jubilee-search-verification=';
export const wellKnownPath = (token) => `/.well-known/jubilee-search-${token}.txt`;

/** 20 random bytes, base64url: unguessable and safe inside a file name. */
export const newToken = () => randomBytes(20).toString('base64url');

/**
 * Is the token published as a TXT record on the host?
 * @returns {{ok: boolean, reason?: string, records?: string[]}}
 */
export async function checkDnsTxt(host, token, { resolver = resolveTxt } = {}) {
  if (!token) return { ok: false, reason: 'no verification token has been issued' };
  let records;
  try {
    // resolveTxt returns string[][] -- each record split at 255-byte chunks.
    records = (await resolver(host)).map((chunks) => chunks.join(''));
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${err.code ?? err.message}` };
  }
  const wanted = `${TXT_PREFIX}${token}`;
  const found = records.some((r) => r.trim() === wanted);
  return found
    ? { ok: true, records }
    : { ok: false, reason: `no TXT record equal to ${TXT_PREFIX}<token> on ${host}`, records };
}

/**
 * Is the token served from the well-known path over HTTPS on the host itself?
 * @returns {{ok: boolean, reason?: string, status?: number}}
 */
export async function checkWellKnown(host, token, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  if (!token) return { ok: false, reason: 'no verification token has been issued' };
  const url = `https://${host}${wellKnownPath(token)}`;
  let res;
  try {
    res = await fetcher(url, {
      // A redirect to another host would let a site prove ownership of a
      // domain it merely points at. Follow nothing.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'JubileeSearch-Verifier/1.0' },
    });
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` };
  }
  if (res.status !== 200) return { ok: false, reason: `expected 200 from ${url}, got ${res.status}`, status: res.status };
  let body = '';
  try { body = (await res.text()).slice(0, 4096); } catch { /* unreadable body is a miss */ }
  return body.includes(token)
    ? { ok: true, status: 200 }
    : { ok: false, reason: `${url} was served but does not contain the token`, status: 200 };
}

/** Dispatch on method. `authoritative_list` is an attestation and needs no probe. */
export async function checkProof(method, host, token, deps = {}) {
  if (method === 'dns_txt') return checkDnsTxt(host, token, deps);
  if (method === 'well_known') return checkWellKnown(host, token, deps);
  if (method === 'authoritative_list') return { ok: true };
  return { ok: false, reason: `unknown method ${method}` };
}
