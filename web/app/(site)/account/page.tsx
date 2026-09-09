import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, isAdmin, canView } from '@/lib/session';
import styles from '../legal.module.css';

// The signed-in account page.
//
// The door (/signin) is for people who are not signed in; this is what the
// account chip in the header points at once they are. It exists to answer three
// questions and nothing else: who am I signed in as, what does it change, and
// how do I stop.
//
// There is nothing to edit here. §14 puts the identity at the Jubilee ID
// authority — name, email and password all live there — so a form on this page
// would either do nothing or quietly write to a user table this site must not
// have.

export const metadata: Metadata = {
  title: 'Your account',
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect('/signin?next=%2Faccount');

  const admin = isAdmin(session);
  const viewer = canView(session);

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>JubileeSearch</p>
      <h1 className={styles.title}>Your <span>account</span></h1>

      <p className={styles.lead}>
        You are signed in with your Jubilee ID. Search works without one — signing
        in changes exactly one thing about what is recorded, and it is set out below.
      </p>

      <div className={styles.meta}>
        <span><b>Signed in as</b> {session.name ?? session.jubilee_id}</span>
        {session.email && <span><b>Email</b> {session.email}</span>}
      </div>

      <Section n="1" title="What this changes">
        <ul>
          <li><strong>300 searches a minute</strong> instead of 60.</li>
          <li>
            <strong>Your searches are stored with your Jubilee ID</strong> rather than
            anonymously. That is the cost, and the{' '}
            <Link href="/privacy">privacy notice</Link> says what it means and for
            how long.
          </li>
          {viewer && (
            <li>
              Your Jubilee ID carries <code>{admin ? 'search_admin' : 'search_viewer'}</code>,
              so the <Link href="/admin">admin console</Link> is open to you
              {admin ? '.' : ' read-only.'}
            </li>
          )}
        </ul>
      </Section>

      <Section n="2" title="Changing your name, email or password">
        <p>
          None of those live here. Your Jubilee ID is issued and held by the Jubilee
          ID service, and it is the same identity on every Jubilee site — so a change
          made there applies everywhere, including here, the next time you sign in.
          JubileeSearch stores no password and has nothing to reset.
        </p>
      </Section>

      <Section n="3" title="Signing out">
        <p>
          This stops new searches being recorded against your Jubilee ID immediately.
          It does not delete what is already recorded; ask us for that, and the{' '}
          <Link href="/privacy">privacy notice</Link> says how.
        </p>
        {/* POST, not a link: a GET sign-out can be triggered by any page that can
            make a browser fetch a URL. */}
        <form method="POST" action="/api/auth/signout" className={styles.signoutForm}>
          <input type="hidden" name="next" value="/" />
          <button type="submit" className={styles.signout}>Sign out</button>
        </form>
      </Section>

      <nav className={styles.footerNav}>
        <Link href="/">Search</Link>
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/terms">Terms of use</Link>
        {viewer && <Link href="/admin">Admin console</Link>}
      </nav>
    </main>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 id={`s${n}`}><em>{n}</em>{title}</h2>
      {children}
    </section>
  );
}
