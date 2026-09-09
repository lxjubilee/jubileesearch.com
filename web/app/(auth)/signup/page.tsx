import type { Metadata } from 'next';
import JubileeIdDoor from '@/components/auth/JubileeIdDoor';
import { doorParams } from '@/lib/door-params';
import { missingConfig } from '@/lib/sso';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const metadata: Metadata = {
  title: "Create your Jubilee ID",
  robots: { index: false, follow: false },
};

/*
 * One door: /signin, /login and /signup all render the SAME email-first screen,
 * which then routes to sign-in or to creating a Jubilee ID. The flow is
 * components/auth/JubileeIdDoor.tsx, so the heading and the behaviour are
 * identical whichever URL someone arrived on.
 *
 * Reading searchParams here makes the route dynamic, which is what these pages
 * want anyway: they are noindex, per-visitor, and must never be cached.
 */
export default async function Page(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = doorParams(await searchParams);

  // Someone already signed in has no business on the email screen. The account
  // page is where the session is shown and ended.
  if (await getSession()) redirect(params.returnUrl === '/' ? '/account' : params.returnUrl);

  const missing = missingConfig();

  // Named, not swallowed. Without these the door reaches the authority and gets
  // nothing, and "try again in a moment" would be false: it is not a moment, it
  // is a missing environment variable.
  const configWarning = missing.length
    ? `Sign-in is not configured on this deployment. Missing: ${missing.join(', ')}.`
    : '';

  return <JubileeIdDoor {...params} configWarning={configWarning} />;
}
