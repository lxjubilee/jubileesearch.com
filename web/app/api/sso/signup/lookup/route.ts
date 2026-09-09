import * as sso from '@/lib/sso';
import { json, readJson, normalizeEmail, EMAIL_RE, UNAVAILABLE } from '@/lib/sso-door';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Screen 1: which of the three outcomes is this email?
//
// Ported from kJubilee's app/api/sso/signup/lookup/route.js. One branch of that
// route is deliberately absent: it checks a local `kj_users` table first, so
// Outcome A still works when the authority is down. JubileeSearch has no local
// mirror and §14 says it must not grow one, so the authority is the only source
// of truth here and an outage is reported as an outage.
//
// `existsLocally` is still in the reply, always false, because the door reads
// the same field on both sites and a shared component should not need to know
// which one it is talking to.

export async function POST(request: Request) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);

  if (!email || !EMAIL_RE.test(email)) {
    return json({ success: false, error: 'Please enter a valid email address.' }, 400);
  }

  if (!sso.isConfigured()) {
    // Without credentials nothing can be looked up, and answering "no Jubilee
    // ID" would send the reader into a create-account flow that cannot work.
    return json({ success: false, error: UNAVAILABLE, ssoConfigured: false }, 503);
  }

  const result = await sso.ssoLookup(email);
  if (!result.ok) {
    console.error('[sso/lookup]', result.status, result.error);
    return json({ success: false, error: UNAVAILABLE }, 503);
  }

  // exists → Outcome A/B (confirm the Jubilee ID password)
  // else   → Outcome C (create the Jubilee ID)
  const exists = Boolean(result.data.exists);
  return json({ success: true, existsLocally: exists, existsInSso: exists });
}
