import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession, isAdmin, canView } from '@/lib/session';
import { mirroredUser } from '@/lib/api';
import AccountClient from './AccountClient';
import './account.css';

// /account — profile settings.
//
// Ported from kJubilee's app/account: the identity strip, then four cards in
// ascending order of consequence. A name is fixed by typing over it. The email
// cannot be changed here at all: it is the join between this account and the
// Jubilee ID. A password is set by typing the new one twice, and the change
// reaches every Jubilee site. Deleting is irreversible, so it stays folded
// shut until asked for and will not arm until DELETE has been typed out.
//
// Where kJubilee reads the session from localStorage after hydration and shows
// "Loading your account…" first, this reads the httpOnly cookie on the server
// and renders the settled page in the first byte of HTML. A signed-out visitor
// is sent to the door rather than shown a dead form.
//
// THE GATE HERE IS NOT THE SECURITY: every route under /api/account reads the
// session again before it answers.

export const metadata: Metadata = {
  title: 'Profile settings',
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect('/signin?next=%2Faccount');

  // When this person first arrived and was last here, from the engine's
  // mirror. Best effort: the page is complete without it.
  const mirror = await mirroredUser(session.access_token);

  // A cookie sealed before first/last were carried has only `name`; split it
  // once so the fields are not blank for someone who signed in last week.
  const parts = (session.name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = session.first_name ?? mirror?.first_name ?? parts[0] ?? '';
  const last = session.last_name ?? mirror?.last_name ?? parts.slice(1).join(' ');

  return (
    <AccountClient
      account={{
        name: session.name,
        first_name: first,
        last_name: last,
        email: session.email ?? '',
        role: isAdmin(session) ? 'admin' : canView(session) ? 'viewer' : null,
        first_seen_at: mirror?.first_seen_at ?? null,
        last_seen_at: mirror?.last_seen_at ?? null,
      }}
    />
  );
}
