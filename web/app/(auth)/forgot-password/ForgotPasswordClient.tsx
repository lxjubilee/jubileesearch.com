'use client';

/* ─────────────────────────────────────────────────────────────────────────
   "Forgot your password?" — step one of a reset JubileeSearch owns.

   Ported from kJubilee's app/forgot-password/client.js. The Jubilee ID
   authority stores a reset code but does not email it: "the requesting SITE
   owns the reset UX". So this is that UX. The link is issued and sent from
   noreply@jubileesearch.com; the new password is set on the Jubilee ID when
   the link is opened (app/(auth)/reset-password).

   The screen never says whether an address has a Jubilee ID. It cannot: a
   form that answers that question is an account enumerator. Submitting always
   lands on the same "check your inbox" panel.
   ───────────────────────────────────────────────────────────────────────── */

import { useState, useEffect } from 'react';
import AuthShell from '@/components/auth/AuthShell';
import Turnstile from '@/components/auth/Turnstile';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FAILED = 'We could not send the reset email just now. Please try again in a moment.';

export default function ForgotPasswordClient(
  { initialEmail = '', turnstileSiteKey = '' }: { initialEmail?: string; turnstileSiteKey?: string },
) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Guarded because each submit spends a real email at somebody else's address.
  const [tnToken, setTnToken] = useState('');
  const [tnBroken, setTnBroken] = useState(false);
  const [tnNonce, setTnNonce] = useState(0);
  const [resent, setResent] = useState(false);

  // A cooldown, not just politeness: one address may hold only three live
  // links. Without this, four impatient clicks burn the allowance and every
  // further request is declined in silence.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const startCooldown = () => setCooldown(30);

  async function send(addr: string): Promise<{ ok: boolean; message: string }> {
    setError('');
    setLoading(true);
    let ok = false;
    let message = '';
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: addr, turnstileToken: tnToken }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      ok = res.ok && data.success === true;
      message = data.error || '';
    } catch {
      message = '';
    }
    setLoading(false);

    // A Turnstile token is spent the moment it is checked, pass or fail, so
    // every outcome needs a fresh challenge before the next attempt.
    setTnToken('');
    setTnNonce((n) => n + 1);
    return { ok, message };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return setError('Please enter your email address.');
    if (!EMAIL_RE.test(addr)) return setError('That does not look like a complete email address. Please check it.');
    if (turnstileSiteKey && !tnToken && !tnBroken) return setError('Please complete the human verification.');

    const { ok, message } = await send(addr);
    // A failure here is OUR failure. Only then is there something to say;
    // otherwise the answer is always the same.
    if (ok) { setEmail(addr); setSent(true); startCooldown(); return; }
    setError(message || FAILED);
  }

  async function onResend() {
    if (cooldown > 0 || loading) return;
    if (turnstileSiteKey && !tnToken && !tnBroken) return setError('Please complete the human verification.');
    const { ok, message } = await send(email);
    if (ok) { setResent(true); startCooldown(); return; }
    setError(message || FAILED);
  }

  const challenge = (
    <Turnstile
      siteKey={turnstileSiteKey}
      onToken={(t) => { setTnToken(t); if (t) setTnBroken(false); }}
      onUnavailable={() => { setTnToken(''); setTnBroken(true); }}
      resetNonce={tnNonce}
    />
  );

  if (sent) {
    return (
      <AuthShell>
        <h1 className="door-heading">Check your email</h1>
        <p className="door-subtext">
          If a Jubilee ID exists for <strong>{email}</strong>, a link to choose a new password
          is on its way. It works once and expires in an hour.
        </p>
        <div className="account-row">
          <span className="account-email" title={email}>{email}</span>
          <button type="button" className="use-different"
                  onClick={() => { setSent(false); setResent(false); setError(''); }}>
            Use a different email
          </button>
        </div>

        {error && <div className="auth-alert auth-alert--error" role="alert">{error}</div>}
        {resent && !error && (
          <div className="auth-alert auth-alert--notice" role="status">
            Sent again. The newest link is the one that works.
          </div>
        )}

        <p className="door-disclaimer" style={{ marginTop: 0 }}>
          Nothing arrived? Check your spam folder &mdash; then send another.
        </p>

        {/* The challenge stays on this screen because the resend needs a token
            of its own: the one used to send the first link was spent. */}
        {challenge}

        <button type="button" className="btn-primary" onClick={onResend} disabled={loading || cooldown > 0}>
          {loading && <span className="spinner" />}
          {loading ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the link'}
        </button>

        <div className="back-link">
          <a href="/signin" className="forgot-link">Back to sign in</a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="door-heading">Reset your password</h1>
      <p className="door-helper">
        Enter the email on your Jubilee ID and we&rsquo;ll send you a link to choose a new password.
      </p>
      {error && <div className="auth-alert auth-alert--error" role="alert">{error}</div>}
      <form onSubmit={onSubmit} noValidate>
        <div className="input-group">
          <input id="email" type="email" placeholder=" " value={email}
                 onChange={(e) => setEmail(e.target.value)}
                 required maxLength={254} autoComplete="email" autoFocus />
          <label htmlFor="email">Email address</label>
        </div>
        {challenge}
        {tnBroken && (
          <p className="auth-alert auth-alert--notice" role="status">
            Human verification could not load. Please refresh the page and try again.
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <div className="back-link">
        <a href="/signin" className="forgot-link">Back to sign in</a>
      </div>
    </AuthShell>
  );
}
