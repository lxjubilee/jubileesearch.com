import { getSession, setSession } from '@/lib/session';
import { mirrorUser } from '@/lib/api';
import * as sso from '@/lib/sso';
import { json, readJson, str } from '@/lib/sso-door';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PATCH /api/account  { first_name, last_name }
//
// The one field of the account a person may edit here. Ported from kJubilee's
// app/api/account/route.js, minus the local row: §14 gives this site no user
// table of its own, so the authority is the only copy that takes the change and
// the engine's mirror (migration 034) follows on the next sign-in -- or right
// now, via mirrorUser below, so the page does not show a stale name.
//
// No password asked for. A name is not a credential: getting it wrong is
// embarrassing and reversible in one edit.

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.email) return json({ success: false, error: 'Not signed in.' }, 401);

  const body = await readJson(request);
  const first = str(body.first_name, 80);
  const last = str(body.last_name, 80);
  if (!first) return json({ success: false, error: 'Enter your first name.' }, 400);

  if (!sso.isConfigured()) {
    return json({ success: false, error: 'Your name could not be saved just now. Please try again in a moment.' }, 503);
  }

  const r = await sso.ssoUpdateProfileByEmail(session.email, { first_name: first, last_name: last || null });
  if (!r.ok) {
    console.error('[account.name] authority refused', r.status, r.error);
    return json({ success: false, error: 'Your name could not be saved just now. Please try again in a moment.' }, 503);
  }

  const name = [first, last].filter(Boolean).join(' ');

  // The header greets people by this name and reads it from the cookie, not
  // the authority. Without this it keeps the old one until the next sign-in.
  await setSession({ ...session, name, first_name: first, last_name: last || null });

  // Best effort, as at sign-in: the mirror is reporting, not identity.
  await mirrorUser(session.access_token);

  return json({ success: true, user: { name, first_name: first, last_name: last, email: session.email } });
}
