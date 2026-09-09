import * as sso from '@/lib/sso';
import { json, readJson, normalizeEmail, respondSignedIn, UNAVAILABLE } from '@/lib/sso-door';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Outcome A: password → signed in.
//
// Ported from kJubilee's app/api/sso/login/route.js. Three branches of that
// route are gone, all for the same reason: they exist to sign in an account
// that predates the Jubilee ID door, on a password kJubilee stores itself.
// JubileeSearch has never had a password of its own and §14 forbids it from
// getting one, so a Jubilee ID is the only way in and there is no legacy path
// to fall back to.
//
// What is kept exactly: the password never touches this server's storage, the
// authority decides, and a 401 from it is reported as a wrong password while
// anything else is reported as an outage. Confusing those two tells a person to
// keep retyping a password that was right.

export async function POST(request: Request) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const rememberMe = body.rememberMe !== false;

  if (!email || !password) {
    return json({ success: false, error: 'Email and password are required.' }, 400);
  }
  if (!sso.isConfigured()) {
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  const result = await sso.ssoLogin(email, password);

  if (!result.ok) {
    if (result.status === 401) {
      // Deliberately the same sentence whether the email is unknown or the
      // password is wrong: the door has already told the reader this address
      // has a Jubilee ID, and a different message here would confirm or deny an
      // address to anyone who asks.
      return json({ success: false, error: 'Invalid email or password' }, 401);
    }
    console.error('[sso/login]', result.status, result.error);
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  const user = result.data.user;
  if (!user?.id) {
    console.error('[sso/login] authority returned no user');
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  return respondSignedIn({ ...user, email: user.email || email }, result.data, rememberMe);
}
