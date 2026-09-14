import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, isAdmin, canView } from '@/lib/session';
import { getDashboard, num } from '@/lib/admin';
import AdminNav from '@/components/admin/AdminNav';

// The console shell and its access gate (§15: "Access is by Jubilee ID with role
// rights. A view-only right exists alongside the admin right.")
//
// This gate decides what to *render*. It is not the security boundary: every
// admin endpoint independently requires a bearer token carrying the right, and
// every server action re-checks before it writes. That matters because a Server
// Action is reachable by direct POST whether or not the UI ever drew a button
// for it -- so a layout check alone would be decoration.

// "Sandeep Agarwal" -> "SA", the same disc the site header shows.
function initials(name: string | null, email: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length >= 2 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  if (first) return (first + last).toUpperCase();
  return (email ?? '?').charAt(0).toUpperCase() || '?';
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  // Not signed in: there is nothing to explain, send them to sign in and back.
  if (!session) redirect(`/signin?next=${encodeURIComponent('/admin')}`);

  if (!canView(session)) {
    // Signed in, but this Jubilee ID carries neither right. Say so plainly and
    // name the right, because the fix is an SSO change and the person reading
    // this needs to know what to ask for.
    return (
      <main className="gate">
        <h1>This account has no access to the console</h1>
        <p>
          You are signed in as <strong>{session.name ?? session.jubilee_id}</strong>, but this
          Jubilee ID carries neither <code>search_admin</code> nor <code>search_viewer</code>.
        </p>
        <p>
          Rights are granted by Jubilee ID, not here — there is no separate account for the
          console and nothing on this page can change them. Ask whoever administers Jubilee ID
          to add the right, then sign in again.
        </p>
        <p style={{ marginTop: 22 }}>
          <Link href="/">Back to search</Link>
        </p>
      </main>
    );
  }

  const admin = isAdmin(session);

  // Queue depths live in the navigation because they are the reason to open the
  // console at all. A failed dashboard must not take the whole shell down with
  // it -- the other screens still work.
  let safetyQueue = 0;
  let pendingDomains = 0;
  try {
    const d = await getDashboard();
    safetyQueue = num(d.safety_queue);
    pendingDomains = num(d.pending_domains);
  } catch {
    // Counts are an affordance, not information the shell depends on.
  }

  return (
    <div className="shell">
      <nav className="side" aria-label="Admin sections">
        {/* The head of the sidebar, after JubileeInspire's admin console: the
            persona in a ringed disc, the console's name, the site as an
            eyebrow beneath it. */}
        <Link href="/admin" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/personas/jubilee.png" alt="" className="brandAvatar" width="44" height="44" />
          <span className="brandText">
            <span className="brandTitle">Admin Console</span>
            <span className="brandTag">JubileeSearch</span>
          </span>
        </Link>

        <AdminNav safetyQueue={safetyQueue} pendingDomains={pendingDomains} />

        {/* Who is here and what they may do, in words rather than the name of
            the right: "Administrator" is what the person reading it holds. */}
        <div className="sideFoot">
          <div className="whoRow">
            <span className="whoDisc" aria-hidden="true">{initials(session.name, session.email)}</span>
            <div className="whoText">
              <div className="who">{session.name ?? session.jubilee_id}</div>
              <div className="whoRole">{admin ? 'Administrator' : 'Viewer'}</div>
            </div>
          </div>
          <div className="sideLinks">
            <Link href="/">Back to search</Link>
            <Link href="/account">Account</Link>
          </div>
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}
