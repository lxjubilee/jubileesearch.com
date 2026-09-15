import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { seal, unseal } from './session-crypto';
import {
  SESSION_COOKIE as COOKIE, FAMILY_COOKIE, FLOW_COOKIE,
  cookieSecure, sessionCookieOptions, familyCookieOptions,
} from './session-policy';

// The signed-in session.
//
// §14 is unambiguous about what this may not be: admin access requires "a
// Jubilee ID with the `search_admin` right, issued through the Jubilee SSO
// authority. **Never a separate password system.**" So there is no user table
// here, no password column, no hashing, no reset flow. This module holds what
// the SSO authority said about someone, for as long as it said it, and nothing
// else.
//
// The tokens live in an AES-256-GCM encrypted, httpOnly cookie and never reach
// the browser's JavaScript. That is the point of putting the session here
// rather than in localStorage: `lib/api.ts` attaches the access token to the
// server-side call to the engine, so a token is never in a place an XSS on any
// Jubilee property could read it.
//
// The sealing lives in ./session-crypto and the lifetimes in ./session-policy,
// because proxy.ts renews the token before a page renders and cannot use
// `next/headers` to do it. Both are re-exported here so existing imports hold.

export { seal, unseal };

/** What the SSO authority told us, plus the tokens to keep asking it. */
export interface Session {
  /** `sub` from the ID token. This is the jubilee_id §7.7 stores. */
  jubilee_id: string;
  name: string | null;
  /** The parts behind `name`, so the account page can offer them for editing.
      Optional: a cookie sealed before these existed is still a session. */
  first_name?: string | null;
  last_name?: string | null;
  email: string | null;
  rights: string[];
  access_token: string;
  refresh_token: string | null;
  /** Unix seconds. */
  expires_at: number;
  /**
   * "Keep me signed in on this device", carried INSIDE the seal so that every
   * re-seal (a name edit, a renewal) keeps the choice. Absent means remembered:
   * that was the only behaviour before the field existed.
   */
  remember?: boolean;
}

/** The short-lived state that has to survive the redirect to the SSO. */
export interface AuthFlow {
  state: string;
  nonce: string;
  code_verifier: string;
  /** Where to send them once they are back. Same-origin paths only. */
  next: string;
}

// ---------------------------------------------------------------------------

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const session = unseal<Session>(store.get(COOKIE)?.value);
  if (!session) return null;

  // An expired access token is not a session. proxy.ts renews the token from
  // the family session before this runs, so reaching here with an expired one
  // means there was no family session to renew from, or the authority refused
  // or could not be reached -- and the honest answer is signed out.
  if (session.expires_at <= Math.floor(Date.now() / 1000)) return null;

  return session;
}

/**
 * The cookie's lifetime follows `session.remember`: off means a session cookie
 * that dies with the browser; on means thirty days, sliding on every re-seal.
 * kJubilee spends the same flag on the token lifetime it mints; JubileeSearch
 * does not mint tokens, so the cookie carrying the authority's one is where the
 * choice lands -- and proxy.ts keeps the token inside it fresh.
 */
export async function setSession(session: Session): Promise<void> {
  const store = await cookies();
  const value = seal(session);

  // Browsers drop a cookie over ~4KB silently, which would present as "sign-in
  // does nothing" with no error anywhere. Say so instead.
  if (value.length > 3800) {
    throw new Error(
      `The sealed session is ${value.length} bytes, which will not fit in a cookie. `
      + 'The access token from this SSO is too large to carry client-side; move the session '
      + 'to a server-side store keyed by an opaque cookie id.',
    );
  }

  store.set(COOKIE, value, sessionCookieOptions(session, cookieSecure()));
}

/**
 * The Jubilee ID family session (§ kJubilee lib/family-session.js).
 *
 * A 90-day token from the authority saying this person is signed in across the
 * family. It is sealed exactly like the session and never readable by script:
 * what travels between sites is a one-time ticket minted from it, not this.
 * It is also what proxy.ts spends to renew the access token, so "keep me
 * signed in" survives the token's fifteen minutes.
 */
export async function setFamilySession(token: string, remember = true, maxAgeS?: number): Promise<void> {
  const store = await cookies();
  store.set(FAMILY_COOKIE, seal({ token, at: Date.now() }), familyCookieOptions(remember, cookieSecure(), maxAgeS));
}

export async function getFamilySession(): Promise<string | null> {
  const store = await cookies();
  return unseal<{ token: string }>(store.get(FAMILY_COOKIE)?.value)?.token ?? null;
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
  store.delete(FLOW_COOKIE);
  store.delete(FAMILY_COOKIE);
}

// ---------------------------------------------------------------------------
// The in-flight authorization request
// ---------------------------------------------------------------------------

export async function setAuthFlow(flow: AuthFlow): Promise<void> {
  const store = await cookies();
  store.set(FLOW_COOKIE, seal(flow), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    // Ten minutes is generous for "click the button, sign in, come back". A
    // longer window is a longer window for a stolen state parameter.
    maxAge: 600,
  });
}

export async function takeAuthFlow(): Promise<AuthFlow | null> {
  const store = await cookies();
  const flow = unseal<AuthFlow>(store.get(FLOW_COOKIE)?.value);
  // Single use, whatever happens next. A replayed callback must not find a
  // verifier waiting for it.
  store.delete(FLOW_COOKIE);
  return flow;
}

/** Constant-time comparison for the `state` parameter. */
export function sameState(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const RIGHTS = { admin: 'search_admin', viewer: 'search_viewer' } as const;

export const isAdmin = (s: Session | null) => Boolean(s?.rights.includes(RIGHTS.admin));
export const canView = (s: Session | null) => isAdmin(s) || Boolean(s?.rights.includes(RIGHTS.viewer));

/**
 * Only same-origin paths may be returned to after sign-in. Without this, an
 * `?next=https://elsewhere.example` turns the sign-in route into an open
 * redirect that borrows Jubilee's domain to look trustworthy.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}
