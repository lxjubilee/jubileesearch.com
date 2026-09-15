import { ssoExchangeSession, rightsFrom, displayName, expiresAt } from './sso';
import { mirrorUser } from './api';
import { isRemembered } from './session-policy';
import type { Session } from './session';

// Renewing the access token from the family session.
//
// Called from proxy.ts, before a page renders, when the sealed token is expired
// or about to be. The authority's access token lasts about fifteen minutes and
// there is no refresh token; the 90-day family session is what "Keep me signed
// in on this device" actually rests on. This asks the authority for a fresh
// token against it and hands back a session to re-seal.
//
// Nothing here touches cookies: the proxy owns the request and response, and
// the split keeps this testable and free of Next specifics.

export type RenewResult =
  | { ok: true; session: Session; familyExpiresAt: number | null }
  /** The authority said the family session is revoked, expired or unknown. */
  | { ok: false; dead: true; status: number }
  /** The authority (or the network) did not answer properly. Try again later. */
  | { ok: false; dead: false; status: number };

async function exchange(old: Session, familyToken: string): Promise<RenewResult> {
  const r = await ssoExchangeSession(familyToken);
  if (!r.ok) {
    // 401 is the one answer the contract gives for a dead session. A 404 is
    // NOT read as dead: until the authority has deployed the endpoint at all,
    // a 404 is "no such route", and clearing everyone's cookies over it would
    // turn a deploy-order mistake into a family-wide sign-out.
    return { ok: false, dead: r.status === 401, status: r.status };
  }
  const { user } = r.data;
  if (!r.data.access_token || !user?.id) {
    return { ok: false, dead: false, status: 502 };
  }

  // Rights come from the engine's allowlists, learned through the mirror call
  // exactly as at sign-in (lib/sso-door.ts). Best effort: if the engine is not
  // answering, the rights the person already had are kept rather than dropped
  // -- an admin console that vanishes because the engine hiccuped would read as
  // a revocation nobody made.
  const mirrored = await mirrorUser(r.data.access_token);
  const rights = mirrored.ok
    ? Array.from(new Set([...rightsFrom(user), ...mirrored.rights]))
    : old.rights;

  const familyExp = r.data.session?.expiresAt ? Date.parse(r.data.session.expiresAt) : Number.NaN;

  return {
    ok: true,
    session: {
      jubilee_id: user.id,
      name: displayName(user) ?? old.name,
      first_name: user.first_name ?? old.first_name ?? null,
      last_name: user.last_name ?? old.last_name ?? null,
      email: user.email ?? old.email,
      rights,
      access_token: r.data.access_token,
      refresh_token: null,
      expires_at: expiresAt(r.data),
      remember: isRemembered(old),
    },
    familyExpiresAt: Number.isNaN(familyExp) ? null : Math.floor(familyExp / 1000),
  };
}

// One exchange per person at a time. A page load fans out into several
// requests (the document, prefetches, the account menu's route), and each would
// otherwise ask the authority for its own token. Per process, which is what
// this deployment is; a second process only costs a duplicate exchange, and the
// contract forbids the authority invalidating the other token.
const inFlight = new Map<string, Promise<RenewResult>>();

// After a failure, do not ask again for a little while. An authority outage
// then costs one call per person per ten seconds instead of one per request,
// and the log carries one line per memo entry rather than a flood.
const FAILURE_MEMO_MS = 10_000;
const failures = new Map<string, { at: number; result: RenewResult }>();

export async function renewSession(old: Session, familyToken: string): Promise<RenewResult> {
  const id = old.jubilee_id;

  const memo = failures.get(id);
  if (memo && Date.now() - memo.at < FAILURE_MEMO_MS) return memo.result;

  const pending = inFlight.get(id);
  if (pending) return pending;

  const p = exchange(old, familyToken)
    .catch((err: unknown): RenewResult => {
      console.warn('[session.renew] exchange threw', err instanceof Error ? err.message : String(err));
      return { ok: false, dead: false, status: 503 };
    })
    .then((result) => {
      if (!result.ok) {
        failures.set(id, { at: Date.now(), result });
        console.warn(`[session.renew] ${result.dead ? 'family session dead' : 'authority unavailable'} (${result.status})`);
      } else {
        failures.delete(id);
      }
      return result;
    })
    .finally(() => { inFlight.delete(id); });

  inFlight.set(id, p);
  return p;
}
