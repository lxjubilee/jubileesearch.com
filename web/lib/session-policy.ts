// The rules of the session, as pure functions.
//
// No `server-only`, no `next/headers`: proxy.ts, lib/session.ts and the tests
// all read the same definitions from here, so there is one answer to "how long
// does a cookie live" and "when is a token renewed".

export const SESSION_COOKIE = 'jubilee_session';
export const FAMILY_COOKIE = 'jubilee_family';
export const FLOW_COOKIE = 'jubilee_auth_flow';

/** "Keep me signed in on this device": the device cookie slides to this. */
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;
/** The authority's family session is 90 days; the cookie never outlives it. */
export const FAMILY_MAX_AGE_S = 60 * 60 * 24 * 90;

/**
 * How close to expiry the access token is renewed. Five minutes by default: a
 * page that is open when the token runs out has usually made a request in the
 * last five minutes, so the renewal happens before anyone notices. Widening it
 * (SESSION_RENEW_WINDOW_S) forces the exchange more often, which is how the
 * renewal is exercised against a real authority without waiting.
 */
export const RENEW_WINDOW_S = (() => {
  const n = Number.parseInt(process.env.SESSION_RENEW_WINDOW_S ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();

/**
 * A cookie sealed before `remember` existed is remembered: that was the only
 * behaviour then, and reading it any other way would sign every device out on
 * the deploy that added the field.
 */
export const isRemembered = (s: { remember?: boolean | null } | null | undefined): boolean =>
  s?.remember !== false;

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge?: number;
}

const base = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  // Lax, not Strict: a link arriving from a sibling Jubilee site is a
  // top-level GET, and Strict would withhold the cookie on exactly that
  // navigation.
  sameSite: 'lax',
  path: '/',
});

/** Remembered: thirty days, sliding on every re-seal. Not: dies with the browser. */
export function sessionCookieOptions(
  session: { remember?: boolean | null }, secure: boolean,
): CookieOptions {
  return isRemembered(session)
    ? { ...base(secure), maxAge: SESSION_MAX_AGE_S }
    : base(secure);
}

/**
 * The family cookie follows the same remember choice. `maxAgeS` lets a renewal
 * pass through what the authority said is left on the session; it is clamped so
 * the cookie never claims more than the ninety days the authority grants.
 */
export function familyCookieOptions(
  remember: boolean, secure: boolean, maxAgeS?: number,
): CookieOptions {
  if (!remember) return base(secure);
  const age = maxAgeS === undefined ? FAMILY_MAX_AGE_S : Math.max(0, Math.min(FAMILY_MAX_AGE_S, Math.floor(maxAgeS)));
  return { ...base(secure), maxAge: age };
}

export type RenewDecision = 'none' | 'renew' | 'expired';

/**
 * Whether the access token in a session needs replacing.
 *
 *   none     the token is good for longer than the renewal window
 *   renew    still valid, but inside the window: renew now, quietly
 *   expired  already past: renew if a family session exists, else signed out
 */
export function shouldRenew(
  session: { expires_at: number } | null | undefined, nowS: number,
): RenewDecision {
  if (!session || typeof session.expires_at !== 'number') return 'none';
  if (session.expires_at <= nowS) return 'expired';
  if (session.expires_at - nowS < RENEW_WINDOW_S) return 'renew';
  return 'none';
}

/** Production sets Secure. Behind Cloudflare and nginx the browser-facing scheme is https. */
export const cookieSecure = (): boolean => process.env.NODE_ENV === 'production';
