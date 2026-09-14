import type { Metadata } from 'next';
import ResetPasswordClient from './ResetPasswordClient';

export const metadata: Metadata = {
  title: 'JubileeSearch — Choose a new password',
  robots: { index: false, follow: false },
};

// The token arrives in the emailed link. It is read here rather than in the
// client so the page is dynamic: a reset screen must never be cached.
export default async function Page(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  return <ResetPasswordClient token={typeof raw === 'string' ? raw : ''} />;
}
