import Link from 'next/link';
import { getSession, isAdmin, canView } from '@/lib/session';
import styles from './AccountMenu.module.css';

// Signed-in state in the results header.
//
// A server component, so the header is correct in the first byte of HTML rather
// than flickering from "Sign in" to a name once JavaScript runs.
//
// It is deliberately small. §16 makes sign-in optional and search never
// requires it, so this must not read like an account bar that the reader is
// missing out by ignoring — a quiet link is the right weight for something that
// changes almost nothing for almost everyone.

export default async function AccountMenu({ next = '/' }: { next?: string }) {
  const session = await getSession();

  if (!session) {
    return (
      <Link
        href={`/signin?next=${encodeURIComponent(next)}`}
        className={styles.signin}
        rel="nofollow"
      >
        Sign in
      </Link>
    );
  }

  const label = session.name ?? session.jubilee_id;

  return (
    <div className={styles.account}>
      {canView(session) && (
        // The badge is the way into the console, not just a statement about the
        // token. It was a <span> before, which told an operator they had the
        // right and then gave them nowhere to click.
        //
        // Shown to a viewer as well as an admin: /admin admits `search_viewer`
        // read-only, so hiding it from them would leave the console with no
        // entry point at all. The label names the right the reader actually
        // holds, so it still reports what it used to.
        //
        // Only shown to an identity the SSO granted the right to. Hiding it is a
        // courtesy, not a control: the engine refuses the API, and the console
        // re-checks on every write, regardless of what this renders.
        <Link
          href="/admin"
          className={styles.badge}
          data-level={isAdmin(session) ? 'admin' : 'view'}
          title={isAdmin(session)
            ? 'Open the admin console — your Jubilee ID carries search_admin'
            : 'Open the admin console — read-only, your Jubilee ID carries search_viewer'}
        >
          {isAdmin(session) ? 'Admin' : 'Viewer'}
        </Link>
      )}
      <Link href="/account" className={styles.who} title={session.email ?? session.jubilee_id}>
        <span className={styles.avatar} aria-hidden="true">{label.charAt(0).toUpperCase()}</span>
        <span className={styles.name}>{label}</span>
      </Link>
    </div>
  );
}
