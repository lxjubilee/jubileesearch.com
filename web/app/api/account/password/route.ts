import { getSession } from '@/lib/session';
import * as sso from '@/lib/sso';
import { json, readJson } from '@/lib/sso-door';
import { ssoAuthLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/account/password  { newPassword }
//
// Ported from kJubilee's app/api/account/password/route.js. No current
// password: the session IS the proof, and asking someone to re-prove the
// sign-in they are standing in is a wall in front of the people least able to
// climb it. What holds the line is the live session and the same rate budget
// as the sign-in door -- this is a take-over-the-account button, and a limiter
// is cheap next to what an unthrottled one costs.
//
// The change lands at the Jubilee ID authority (§14: the sole credential
// store), so it is the password on every Jubilee site. Nothing is hashed or
// stored here. Unlike kJubilee there is no local session to re-mint: this
// site's session is the authority's own token in a cookie, and it stays put.

const MIN_PASSWORD = 8;

export async function POST(request: Request) {
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session?.email) return json({ success: false, error: 'Not signed in.' }, 401);

  const body = await readJson(request);
  const newPassword = String(body.newPassword ?? '');
  if (newPassword.length < MIN_PASSWORD) {
    return json({ success: false, error: `Your new password must be at least ${MIN_PASSWORD} characters.` }, 400);
  }
  if (newPassword.length > 200) {
    return json({ success: false, error: 'That password is too long.' }, 400);
  }

  if (!sso.isConfigured()) {
    return json({ success: false, error: 'Your password could not be changed just now. Please try again in a moment.' }, 503);
  }

  const r = await sso.ssoChangePasswordByEmail(session.email, newPassword);
  if (!r.ok) {
    console.error('[account.password] authority refused', r.status, r.error);
    return json({ success: false, error: 'Your password could not be changed just now. Please try again in a moment.' }, 503);
  }

  console.log(`[account] password changed for ${session.email} (jubilee id)`);
  return json({ success: true, scope: 'jubilee-id' });
}
