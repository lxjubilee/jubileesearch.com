import Link from 'next/link';
import AccountMenu from './AccountMenu';
import styles from './SiteHeader.module.css';

// The home page's top bar, modelled on JubileePraise's header (.jvh-header on
// jubileepraise.com): the avatar and Orbitron wordmark on the left and the
// account control on the right, in one 48px bar.
//
// Only the top bar. JubileePraise also carries a menu row, a "Download the Music
// App" pill, a kJubilee Radio link and a small catalogue search; none of them
// is here — the home page is already a search box, and this site has no
// catalogue sections to list.
//
// A server component: AccountMenu reads the session cookie, so a signed-in
// reader sees their initials in the first byte of HTML, never "Sign in" first.

export default function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/personas/jubilee.png" alt="" className={styles.logoIcon} />
          <span className={styles.logoText}>
            Jubilee<span className={styles.logoAccent}>Search</span>.com
          </span>
        </Link>

        <div className={styles.actions}>
          <AccountMenu next="/" variant="bar" />
        </div>
      </div>
    </header>
  );
}
