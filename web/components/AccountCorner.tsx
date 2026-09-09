import AccountMenu from './AccountMenu';
import styles from './AccountCorner.module.css';

// Signed-in state on the home page.
//
// The results page carries AccountMenu in its header; the home page had no
// header to carry it, and so showed a signed-in reader nothing at all -- and
// offered a signed-out one no way to sign in. This is the same component,
// pinned to the corner instead of sitting in a bar.
//
// It reads the session cookie, so the home page renders per request rather than
// being prerendered once at build. That is the honest cost of showing per-user
// state, and it is small here: the page fetches nothing, so the added work is
// one AES-GCM decrypt of a cookie. It is done on the server rather than in the
// browser so the corner is right in the first byte of HTML -- a reader who is
// signed in never sees "Sign in" flash and then rewrite itself.

export default function AccountCorner() {
  return (
    <div className={styles.corner}>
      <AccountMenu next="/" />
    </div>
  );
}
