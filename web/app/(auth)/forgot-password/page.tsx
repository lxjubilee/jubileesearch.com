import type { Metadata } from 'next';
import { siteKey } from '@/lib/turnstile';
import ForgotPasswordClient from './ForgotPasswordClient';

export const metadata: Metadata = {
  title: 'JubileeSearch — Reset your password',
  robots: { index: false, follow: false },
};

// ?email= is carried over from the door, so nobody retypes the address they
// just entered on the sign-in screen.
export default async function Page(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.email) ? sp.email[0] : sp.email;
  return (
    <ForgotPasswordClient
      initialEmail={typeof raw === 'string' ? raw.trim() : ''}
      turnstileSiteKey={siteKey()}
    />
  );
}
