import * as sso from '@/lib/sso';
import { localUserExists } from '@/lib/api';
import { json, readJson, normalizeEmail, EMAIL_RE, UNAVAILABLE } from '@/lib/sso-door';
import { ssoAuthLimiter, clientIp } from '@/lib/rate-limit';
import { verifyTurnstile, HUMAN_CHECK_FAILED } from '@/lib/turnstile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Screen 1: which of the three outcomes is this email?
//
// Ported from kJubilee's app/api/sso/signup/lookup/route.js, and now with the
// branch that port originally left out. This site DOES have a local users table
// (migration 034), so the two questions it asks are genuinely different:
//
//   "who is this?"          — only the authority can say
//   "is this a member HERE?" — only this site can say
//
// Both are needed, because a Jubilee ID is not an account on this site. Someone
// holding one who has never been here should sign UP here, not be signed in as
// though they were already a member.

export async function POST(request: Request) {
  // This route answers "does this address have a Jubilee ID". Unthrottled,
  // that is an enumeration oracle for any address someone cares to try.
  const limited = ssoAuthLimiter(request);
  if (limited) return limited;

  const body = await readJson(request);
  const email = normalizeEmail(body.email);

  if (!email || !EMAIL_RE.test(email)) {
    return json({ success: false, error: 'Please enter a valid email address.' }, 400);
  }

  // Human verification. Checked BEFORE the lookup below, because that lookup is
  // what a script would be here for: it answers whether an address has a Jubilee
  // ID, one address per request, for free.
  const human = await verifyTurnstile(body.turnstileToken, clientIp(request));
  if (!human.ok) {
    console.warn('[sso/lookup] turnstile rejected a request:', human.reason);
    return json({ success: false, error: HUMAN_CHECK_FAILED }, 403);
  }

  if (!sso.isConfigured()) {
    // Without credentials nothing can be looked up, and answering "no Jubilee
    // ID" would send the reader into a create-account flow that cannot work.
    return json({ success: false, error: UNAVAILABLE, ssoConfigured: false }, 503);
  }

  // LOCAL FIRST, in JubileeInspire's order and for its reason: a row in this
  // site's own users table is decisive and needs no second opinion, so a member
  // still gets "welcome back" on a day the authority is unreachable. Only
  // someone with no row here needs the authority asked at all.
  //
  // existsInSso is reported true alongside it without asking, because a local
  // row is only ever written from an identity the authority already vouched
  // for — the answer is known, and a call that cannot change the outcome is a
  // call worth not making.
  const local = await localUserExists(email);
  if (local === true) {
    return json({ success: true, existsLocally: true, existsInSso: true });
  }
  if (local === null) {
    // Membership could not be determined. Flattening that to false would send
    // an existing member into a sign-up they neither need nor can complete, so
    // it is reported the same way an authority outage is.
    console.error('[sso/lookup] local membership check unavailable');
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  const result = await sso.ssoLookup(email);
  if (!result.ok) {
    console.error('[sso/lookup]', result.status, result.error);
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  // With no row here the two answers can genuinely differ:
  //   in SSO  → Outcome B: has a Jubilee ID, new to this site — sign up here
  //   neither → Outcome C: new everywhere — create the Jubilee ID too
  return json({
    success: true,
    existsLocally: false,
    existsInSso: Boolean(result.data.exists),
  });
}
