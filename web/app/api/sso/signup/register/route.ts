import * as sso from '@/lib/sso';
import {
  json, readJson, normalizeEmail, str, validateDob, respondSignedIn,
  EMAIL_RE, UNAVAILABLE,
} from '@/lib/sso-door';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Outcome C: create the Jubilee ID.
//
// On kJubilee this creates two things — the Jubilee ID at the authority and a
// `kj_users` row here — which is why its route is twice this length. There is
// no second thing to create on JubileeSearch: search has no account of its own,
// and signing in changes exactly one thing about what is recorded (the privacy
// notice says so). So this creates the Jubilee ID and signs the person in.
//
// Every check below is mirrored on the client. That is a courtesy there and the
// gate here: a request crafted by hand skips the form entirely.

export async function POST(request: Request) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const first_name = str(body.first_name, 50);
  const last_name = str(body.last_name, 50);
  const date_of_birth = str(body.date_of_birth, 10);
  const password = String(body.password ?? '');
  const rememberMe = body.rememberMe !== false;

  if (!email || !EMAIL_RE.test(email)) {
    return json({ success: false, error: 'Please enter a valid email address.' }, 400);
  }
  if (!first_name || !last_name) {
    return json({ success: false, error: 'Please enter your first and last name.' }, 400);
  }
  // Required here, not just on the form. The door's own comment calls the
  // client-side rule "a courtesy, not the gate" -- which was not true of a
  // MISSING date: `validateDob` treats an empty one as optional, so a request
  // that skipped the form created an account with no date of birth and the
  // minimum-age rule never ran on it. The form has always demanded it; now so
  // does the route.
  if (!date_of_birth) {
    return json({ success: false, error: 'Please enter your date of birth.' }, 400);
  }
  const dobError = validateDob(date_of_birth);
  if (dobError) return json({ success: false, error: dobError }, 400);
  if (password.length < 8) {
    return json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
  }
  if (!sso.isConfigured()) {
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  const result = await sso.ssoRegister({
    first_name, last_name, email, date_of_birth: date_of_birth || null, password,
  });

  if (!result.ok) {
    if (result.status === 409) {
      // The email gained a Jubilee ID between Screen 1 and here. The door sends
      // them to the password screen rather than losing what they typed.
      return json({
        success: false,
        error: 'An account already exists for this email — please sign in.',
      }, 409);
    }
    console.error('[sso/register]', result.status, result.error);
    return json({ success: false, error: result.error || UNAVAILABLE }, 503);
  }

  const user = result.data.user;
  if (!user?.id) {
    console.error('[sso/register] authority returned no user');
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  return respondSignedIn({ ...user, email: user.email || email }, result.data, rememberMe);
}
