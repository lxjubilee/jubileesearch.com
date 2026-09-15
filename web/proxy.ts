import { NextResponse, type NextRequest } from 'next/server';
import { seal, unseal } from '@/lib/session-crypto';
import {
  SESSION_COOKIE, FAMILY_COOKIE,
  cookieSecure, sessionCookieOptions, familyCookieOptions, isRemembered, shouldRenew,
} from '@/lib/session-policy';
import { renewSession } from '@/lib/session-renew';
import type { Session } from '@/lib/session';

// Keeping the person signed in.
//
// The session cookie may live thirty days, but the authority's access token
// sealed inside it lasts about fifteen minutes and there is no refresh token.
// Without this file, "Keep me signed in on this device" was a thirty-day cookie
// around a token that had already expired by the time the browser was reopened:
// getSession() honestly answered "signed out" and the checkbox appeared to do
// nothing.
//
// This is a proxy (Next 16's name for middleware) because it is the only place
// that runs BEFORE server components render and can both write a response
// cookie and rewrite the request's cookie header, so the very first paint after
// a renewal is signed in. Server components can only read cookies; a route
// handler runs too late for the page that needed it.
//
// It runs on the Node runtime (the only runtime a proxy has in this version),
// which is why node:crypto in lib/session-crypto works here. `next/headers`
// cookies() is deliberately not used: request.cookies and response.cookies are
// the proxy's own API, and Next merges the Set-Cookie written here into the
// cookies() store the rest of this same request reads.
//
// It never redirects and never renders. Anonymous visitors cost one cookie
// lookup; signed-in ones cost one decrypt; the authority is asked only inside
// the renewal window, and lib/session-renew de-duplicates that.

export async function proxy(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return NextResponse.next();

  const session = unseal<Session>(raw);
  const now = Math.floor(Date.now() / 1000);
  const decision = session ? shouldRenew(session, now) : 'expired';
  if (decision === 'none') return NextResponse.next();

  const family = unseal<{ token: string }>(request.cookies.get(FAMILY_COOKIE)?.value)?.token ?? null;
  const secure = cookieSecure();

  // Nothing to renew from: an undecryptable cookie, or an expired token with no
  // family session behind it. Stop sending the stale cookie, render signed out.
  if (!session || (decision === 'expired' && !family)) {
    return passThrough(request, (res) => { res.cookies.delete(SESSION_COOKIE); }, [SESSION_COOKIE]);
  }
  if (!family) return NextResponse.next();   // 'renew' with no family: still valid, nothing to do

  const result = await renewSession(session, family);

  if (result.ok) {
    const sealed = seal(result.session);
    const remember = isRemembered(result.session);
    return passThrough(request, (res) => {
      res.cookies.set(SESSION_COOKIE, sealed, sessionCookieOptions(result.session, secure));
      // The family cookie is re-set only when the authority reported sliding
      // its session, and never for longer than what it said is left.
      if (result.familyExpiresAt !== null) {
        res.cookies.set(
          FAMILY_COOKIE,
          seal({ token: family, at: Date.now() }),
          familyCookieOptions(remember, secure, result.familyExpiresAt - now),
        );
      }
    }, [], { [SESSION_COOKIE]: sealed });
  }

  if (result.dead) {
    // The family session is revoked or expired. Keeping the cookies would retry
    // this exchange on every request until the session cookie itself expired,
    // so both go now and the person is signed out cleanly.
    return passThrough(request, (res) => {
      res.cookies.delete(SESSION_COOKIE);
      res.cookies.delete(FAMILY_COOKIE);
    }, [SESSION_COOKIE, FAMILY_COOKIE]);
  }

  // Transient: the authority or network did not answer. Cookies are left
  // exactly as they were -- an outage must not become a forced re-login. With
  // 'renew' the old token is still valid and the page is signed in; with
  // 'expired' this render is signed out and the next request after recovery
  // signs the person back in silently.
  return NextResponse.next();
}

/**
 * Continue to the app with the request's cookie header rewritten so this same
 * render sees the change, and the matching Set-Cookie on the response so the
 * browser does too.
 */
function passThrough(
  request: NextRequest,
  onResponse: (res: NextResponse) => void,
  deleteFromRequest: string[],
  setOnRequest: Record<string, string> = {},
): NextResponse {
  for (const name of deleteFromRequest) request.cookies.delete(name);
  for (const [name, value] of Object.entries(setOnRequest)) request.cookies.set(name, value);
  const res = NextResponse.next({ request: { headers: request.headers } });
  onResponse(res);
  // A response that sets a credential is for this browser only.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  // Pages, plus the account routes that need a live token when a tab has been
  // idle past the token's lifetime. Excluded: the door and sign-out routes
  // (/api/sso, /api/auth), which create and destroy sessions themselves; the
  // engine rewrite (/api/v1) and suggest, which never read one; and static
  // assets. Matcher values must be constants.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\..*).*)',
    '/api/account/:path*',
  ],
};
