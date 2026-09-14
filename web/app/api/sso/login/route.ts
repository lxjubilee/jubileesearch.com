import * as sso from '@/lib/sso';
import { localUserExists } from '@/lib/api';
import { json, readJson, normalizeEmail, respondSignedIn, UNAVAILABLE } from '@/lib/sso-door';
import { ssoAuthLimiter } from '@/lib/rate-limit';

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
  // Before anything else, and before the body is even read: this route hands
  // every attempt straight to the authority, so the budget has to be spent here.
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const rememberMe = body.rememberMe !== false;
  // Sent ONLY by the create-account screen the redirect below opens. The
  // password screen never sends it, so signing in cannot resurrect an account
  // that was deliberately removed.
  const provision = body.provision === true;

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

  // THE PASSWORD IS RIGHT. THAT IS NOT THE SAME AS BEING A MEMBER HERE.
  //
  // JubileeInspire's contract, followed exactly. A correct Jubilee ID password
  // proves who someone is; this site then asks its own question — is there an
  // account here? If not, the answer is neither an error nor a sign-in. It is
  // `redirect: 'signup-existing'` carrying the profile the authority just
  // returned, so the door opens a pre-filled create-account screen instead of
  // dead-ending someone who typed their password correctly.
  //
  // NO AUTO-PROVISION ON A BARE SIGN-IN: creating the row here would bring a
  // deliberately removed account back the moment its owner signed in again.
  if (!provision) {
    const local = await localUserExists(email);
    if (local === null) {
      console.error('[sso/login] local membership check unavailable');
      return json({ success: false, error: UNAVAILABLE }, 503);
    }
    if (local === false) {
      return json({
        success: false,
        redirect: 'signup-existing',
        email,
        first_name: user.first_name ?? '',
        last_name: user.last_name ?? '',
        date_of_birth: String(user.date_of_birth ?? '').slice(0, 10),
      });
    }
  }

  return respondSignedIn({ ...user, email: user.email || email }, result.data, rememberMe);
}
