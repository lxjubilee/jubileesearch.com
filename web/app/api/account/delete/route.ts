import { getSession, getFamilySession, clearSession } from '@/lib/session';
import { deleteMirroredUser } from '@/lib/api';
import { ssoRevokeSession } from '@/lib/sso';
import { json, readJson } from '@/lib/sso-door';
import { ssoAuthLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/account/delete  { confirm }
//
// Ported from kJubilee's app/api/account/delete/route.js. Deletes THIS site's
// membership -- the engine's mirrored row (migration 034) -- and ends the
// session here and in the family. The Jubilee ID is left alone: it is
// family-wide, other sites are built on it, and one property closing an
// identity it does not own is not a setting, it is a bug with a confirmation
// dialog. The screen says so, because "delete my account" plainly reads as
// "delete all of it" to the person clicking it.
//
// No password. The session establishes who is calling, and the typed word is
// the lock that catches this route's real hazard: the owner who did not mean
// it. A password is muscle memory and a browser will fill it in; typing DELETE
// cannot happen by accident.

const CONFIRM_WORD = 'DELETE';

export async function POST(request: Request) {
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session) return json({ success: false, error: 'Not signed in.' }, 401);

  const body = await readJson(request);
  if (String(body.confirm ?? '').trim().toUpperCase() !== CONFIRM_WORD) {
    return json({ success: false, error: `Type ${CONFIRM_WORD} to confirm.` }, 400);
  }

  const gone = await deleteMirroredUser(session.access_token);
  if (!gone) {
    return json({ success: false, error: 'Your account could not be deleted just now. Please try again in a moment.' }, 503);
  }

  // Signed out everywhere this site can reach: the local cookies, and the
  // 90-day family session that was opened at sign-in. Best effort on the
  // second -- the membership is already gone, which is the part that matters.
  const familyToken = await getFamilySession();
  await clearSession();
  if (familyToken) {
    try { await ssoRevokeSession(familyToken); } catch { /* already signed out here */ }
  }

  console.log(`[account] membership deleted for ${session.email ?? session.jubilee_id}`);
  return json({ success: true, kept_jubilee_id: true });
}
