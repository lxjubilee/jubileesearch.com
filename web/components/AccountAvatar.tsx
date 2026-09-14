'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import styles from './AccountMenu.module.css';

// The signed-in disc and the menu under it.
//
// Ported from kJubilee's app/_account-button.js: a blue disc carrying the
// person's initials, and beneath it a small panel with who is signed in,
// "Profile settings" and "Sign out". The difference from kJubilee is where the
// session lives. There it is in localStorage and this component has to read it
// after hydration; here it is an httpOnly cookie the server has already read,
// so AccountMenu (a server component) decides whether to render this at all and
// hands it the name and address. This only owns the open/closed state.
//
// Sign out is a real form POST, not a fetch: /api/auth/signout is POST-only for
// CSRF reasons and answers with a redirect to /signin, and a form submission
// follows that redirect with a full page load -- which is what a sign-out
// wants, since every server component on the page rendered signed-in.

// "Sandeep Agarwal" -> "SA". Both initials, because one letter is not an
// identity. Falls back to one letter for a single-word name, and to the address
// when there is no name at all, so the disc is never empty.
export function initials(name: string | null, email: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length >= 2 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  if (first) return (first + last).toUpperCase();
  return (email ?? '?').charAt(0).toUpperCase() || '?';
}

export default function AccountAvatar(
  { name, email }: { name: string | null; email: string | null },
) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fullName = (name ?? '').trim() || (email ?? '').split('@')[0];

  return (
    <div className={styles.avatarBox} ref={boxRef}>
      <button
        type="button"
        className={styles.avatarButton}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email ?? fullName}
      >
        <span className={styles.avatar} aria-hidden="true">{initials(name, email)}</span>
        <span className={styles.srOnly}>{fullName}</span>
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {/* The name says WHO, the address says WHICH ACCOUNT. */}
          <div className={styles.who}>
            <div className={styles.fullName}>{fullName}</div>
            {email && <div className={styles.email} title={email}>{email}</div>}
          </div>
          <Link href="/account" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            Profile settings
          </Link>
          <form method="POST" action="/api/auth/signout" className={styles.itemForm}>
            <input type="hidden" name="next" value="/signin" />
            <button type="submit" className={styles.item} role="menuitem">Sign out</button>
          </form>
        </div>
      )}
    </div>
  );
}
