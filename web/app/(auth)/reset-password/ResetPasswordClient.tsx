'use client';

/* ─────────────────────────────────────────────────────────────────────────
   Step two of the reset: the link has been opened, so choose a new password.

   Ported from kJubilee's app/reset-password/client.js. The link is checked
   BEFORE this screen draws a form: a dead or spent link should say so at once
   rather than after someone has typed a password twice. A spent link is the
   normal case, because finishing a reset burns every outstanding link for that
   address.

   The new password lands at the Jubilee ID authority (lib/password-reset.ts);
   JubileeSearch holds no password of its own.
   ───────────────────────────────────────────────────────────────────────── */

import { useState, useEffect } from 'react';
import AuthShell from '@/components/auth/AuthShell';
import PasswordField, { PasswordStrength, PasswordMatch } from '@/components/auth/PasswordField';

type State = 'checking' | 'ready' | 'invalid' | 'done';

export default function ResetPasswordClient({ token = '' }: { token?: string }) {
  const [state, setState] = useState<State>(token ? 'checking' : 'invalid');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Editing a field answers the complaint about it, so the complaint should go.
  const edit = (set: (v: string) => void) => (v: string) => { set(v); if (error) setError(''); };

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { valid?: boolean; email?: string }) => {
        if (!alive) return;
        if (d.valid) { setEmail(d.email || ''); setState('ready'); } else setState('invalid');
      })
      .catch(() => { if (alive) setState('invalid'); });
    return () => { alive = false; };
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || password.length < 8) return setError('Password must be at least 8 characters.');
    // Write-only, so it is asked twice: a typo here is discovered the next
    // time they try to sign in, on every Jubilee site at once.
    if (password !== confirm) return setError('Those passwords do not match.');
    setError('');
    setLoading(true);
    let data: { success?: boolean; error?: string } = {};
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      data = await res.json().catch(() => ({}));
    } catch { /* handled below */ }
    setLoading(false);

    if (data.success) { setPassword(''); setConfirm(''); setState('done'); return; }
    setError(data.error || 'Could not set your new password. Please try again.');
  }

  if (state === 'checking') {
    return (
      <AuthShell>
        <h1 className="door-heading">One moment</h1>
        <p className="door-subtext">Checking your reset link…</p>
      </AuthShell>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthShell>
        <h1 className="door-heading">This link has expired</h1>
        <p className="door-subtext">
          Reset links work once and last an hour, and finishing a reset retires any
          others. Ask for a fresh one and it will be with you in a moment.
        </p>
        <a href="/forgot-password" className="btn-primary" style={{ textDecoration: 'none' }}>
          Send a new link
        </a>
        <div className="back-link">
          <a href="/signin" className="forgot-link">Back to sign in</a>
        </div>
      </AuthShell>
    );
  }

  if (state === 'done') {
    return (
      <AuthShell>
        <div className="success-state">
          <div className="success-icon-circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h2>Password changed</h2>
          <p>Your Jubilee ID now uses the new password &mdash; on JubileeSearch and everywhere else across Jubilee.</p>
          <a href={`/signin?email=${encodeURIComponent(email)}`} className="btn-primary"
             style={{ textDecoration: 'none' }}>
            Sign in
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="door-heading">Choose a new password</h1>
      <p className="door-subtext">
        This sets the password on your Jubilee ID, which is what signs you in
        everywhere across Jubilee.
      </p>
      {error && <div className="auth-alert auth-alert--error" role="alert">{error}</div>}
      {email && (
        <div className="account-row">
          <span className="account-email" title={email}>{email}</span>
        </div>
      )}
      <form onSubmit={onSubmit} noValidate>
        {/* For password managers: they need to know which account the new
            password belongs to, and it is not otherwise on the form. */}
        <input type="text" name="username" autoComplete="username" value={email}
               readOnly hidden aria-hidden="true" tabIndex={-1} />
        <PasswordField id="password" label="New password" value={password}
                       onChange={edit(setPassword)} autoComplete="new-password" minLength={8} autoFocus>
          <PasswordStrength value={password} />
        </PasswordField>
        <PasswordField id="confirm" label="Confirm new password" value={confirm}
                       onChange={edit(setConfirm)} autoComplete="new-password" minLength={8}>
          <PasswordMatch password={password} confirm={confirm} />
        </PasswordField>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </AuthShell>
  );
}
