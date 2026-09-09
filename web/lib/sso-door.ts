import 'server-only';
import { NextResponse } from 'next/server';
import {
  ssoOpenSession, rightsFrom, displayName, expiresAt,
  type SsoUser, type SsoTokens,
} from './sso';
import { setSession, setFamilySession } from './session';

// The pieces of the Jubilee ID door that more than one route needs.
//
// Ported from kJubilee's `lib/sso-door.js`, minus everything that reads a local
// user table: kJubilee mirrors identities into `kj_users` and can sign someone
// in on a legacy local password. JubileeSearch has no such table and never
// should (§14 — "Never a separate password system"), so the branches for a
// pre-door account and for a local password hash are absent by design rather
// than left out for later.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

export const str = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

/**
 * Mirrors the client-side rule so a hand-crafted request cannot skip it.
 *
 * The rollover check is the part that is easy to leave out and was.
 * `new Date('1978-06-31T00:00:00Z')` does not fail — V8 rolls it forward to the
 * 1st of July and hands back a perfectly valid Date. So a NaN test passes an
 * impossible date straight through, and an account gets a birthday nobody
 * typed. Comparing the parts back against what was sent is what actually
 * rejects it.
 */
export function validateDob(dob: string): string | null {
  if (!dob) return null;   // optional here; the register route requires it
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Date of birth must be a valid date.';

  const [y, m, day] = dob.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(y, m - 1, day));
  if (Number.isNaN(d.getTime())) return 'Date of birth is not a valid date.';
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== day) {
    return 'That date does not exist. Please check the day and the month.';
  }

  const now = new Date();
  if (d > now) return 'Date of birth cannot be in the future.';
  const thirteen = new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));
  if (d > thirteen) return 'Accounts require a minimum age of 13.';
  return null;
}

/**
 * Sign someone in: seal the authority's own tokens into the session cookie and
 * answer in the shape the door expects.
 *
 * **The token is not returned to the browser, and this is the one deliberate
 * divergence from kJubilee.** There, `respondSignedIn` sends `token` back and
 * `storeAuth` puts it in `localStorage` for the radio player and the rail to
 * read. Here two things forbid it:
 *
 *   * The engine verifies the bearer token against the authority's JWKS and
 *     reads `search_admin` from its claims. It is the authority's token or
 *     nothing works -- and an authority token in localStorage is readable by
 *     any XSS on any Jubilee property.
 *   * §14 gates the admin console on that right. A token the browser can read
 *     is a token an attacker can lift and replay against /api/v1/admin/*.
 *
 * So the same flow, the same screens, the same result -- and the credential
 * stays in an httpOnly cookie, which is also where kJubilee keeps the *family*
 * session for exactly this reason.
 */
export async function respondSignedIn(
  user: SsoUser,
  tokens: SsoTokens,
  rememberMe: boolean,
) {
  if (!tokens.access_token) {
    // The authority verified the password but issued nothing to act with. The
    // engine would refuse every call, so this is a failed sign-in, not a
    // partial one.
    return json({
      success: false,
      error: 'Signed in, but no access token was issued. Please try again.',
    }, 503);
  }

  await setSession({
    jubilee_id: user.id,
    name: displayName(user),
    email: user.email ?? null,
    rights: rightsFrom(user),
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: expiresAt(tokens),
  }, rememberMe);

  // AND OPEN THE FAMILY SESSION. Signing in here is proof of identity for the
  // whole family, so the authority is told and the 90-day session is sealed into
  // its own httpOnly cookie. Best-effort: a sign-in that already succeeded must
  // not be turned into an error by the part that is a convenience.
  try {
    const opened = await ssoOpenSession(user.email);
    if (opened.ok && opened.data?.sessionToken) {
      await setFamilySession(opened.data.sessionToken, rememberMe);
    }
  } catch {
    // Signed in to JubileeSearch alone. That is the whole cost.
  }

  return json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name ?? '',
      last_name: user.last_name ?? '',
      name: displayName(user),
      rights: rightsFrom(user),
    },
  });
}

/** The one message for "the authority is not answering". */
export const UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again in a moment.';
