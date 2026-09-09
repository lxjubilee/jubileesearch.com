import { NextResponse } from 'next/server';
import { ssoRevokeSession } from '@/lib/sso';
import { getFamilySession, clearSession, safeNext } from '@/lib/session';

// Sign out.
//
// POST, not GET. A GET sign-out can be triggered by any page that can make the
// browser fetch a URL -- an <img src> on another site is enough -- and signing
// someone out without their asking is a small hostility that is entirely
// avoidable. The account screen's control is a form.
//
// Two things happen, in this order and for a reason: the local session is
// cleared first, so the reader is signed out of JubileeSearch even if the
// authority is unreachable; then the family session is revoked there too.

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const url = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const next = safeNext((form?.get('next') as string | null) ?? url.searchParams.get('next'));

  // Read before clearing -- clearSession() deletes the cookie it lives in.
  const familyToken = await getFamilySession();
  await clearSession();

  // Ending the family session is opt-in. On a network like this one, signing
  // out of search should not necessarily sign someone out of every other
  // Jubilee property they have open -- so it happens only when
  // SSO_END_SESSION_ON_SIGNOUT says it should.
  if (familyToken && process.env.SSO_END_SESSION_ON_SIGNOUT === 'true') {
    try {
      await ssoRevokeSession(familyToken);
    } catch {
      // The local session is already gone, which is the part that matters.
    }
  }

  // Built from the request's own origin: Next normalises request.url to the
  // bound hostname, so this is right behind the tunnel and on 127.0.0.1 alike.
  return NextResponse.redirect(new URL(next, url.origin), { status: 303 });
}
