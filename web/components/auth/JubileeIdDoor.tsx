'use client';

/* ─────────────────────────────────────────────────────────────────────────
   The Jubilee ID door — one email-first screen behind /signin, /login and
   /signup. Ported from kJubilee.com's app/_jubilee-id-door.js.

   Screen 1 asks for an email and nothing else. The email is looked up at the
   Jubilee ID authority and the person is routed to one of two outcomes:

     A  welcome   has a Jubilee ID → password → signed in.
     C  form      no Jubilee ID at all → create the Jubilee ID, signed in.

   kJubilee has a third outcome, B: a Jubilee ID that is new to *that site*,
   which confirms the password and then shows a visible Create Account screen,
   because kJubilee has an account of its own to create. JubileeSearch does not.
   §14 forbids it a user table and §17 says signing in changes exactly one thing
   about what is recorded — so there is nothing to create here, and inventing a
   screen that creates nothing would be a step asking for consent to a thing
   that does not happen.

   A Jubilee ID *is* a verified email address, so nothing in this flow asks
   anyone to check their inbox.

   Server side: app/api/sso/**. Look: app/(auth)/jubilee-id.css.
   ───────────────────────────────────────────────────────────────────────── */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AuthShell from './AuthShell';

const SITE_NAME = 'JubileeSearch';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TERMS_URL = '/terms';
const PRIVACY_URL = '/privacy';

// ── Icons ────────────────────────────────────────────────────────────────
const EyeOpen = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeClosed = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

// ── Password strength ────────────────────────────────────────────────────
function calcStrength(pw: string): 'weak' | 'fair' | 'strong' {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 1;
  if (score <= 2) return 'weak';
  if (score <= 4) return 'fair';
  return 'strong';
}
const STRENGTH_LABEL = { weak: 'Weak password', fair: 'Fair password', strong: 'Strong password' };

// Mirrored server-side in app/api/sso/**, so this is a courtesy, not the gate.
//
// `badInput` is the case a plain `!dob` check gets wrong, and gets wrong in the
// most confusing way available. Type 06/31/1978 into a date input and the
// browser keeps showing those digits while reporting `value` as the empty
// string — June has thirty days, so there is no date to report. Reading only the
// value, the form then says "Please enter your date of birth" to somebody who is
// looking straight at one, and the only way out is to guess which of the three
// boxes the machine dislikes.
//
// The input already knows. `validity.badInput` is exactly "there is something
// in here and it is not a date", so it is asked rather than inferred.
function validateDob(dob: string, badInput = false): string | null {
  if (badInput) return 'That date does not exist. Please check the day and the month.';
  if (!dob) return 'Please enter your date of birth.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Date of birth must be a valid date.';

  // Same rollover check the server makes: `new Date('1978-06-31')` does not
  // fail, it quietly becomes the 1st of July. A date input cannot produce that
  // — it reports badInput above instead — but the two rules should not differ,
  // because a difference between them is how one of them ends up wrong.
  const [y, m, day] = dob.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(y, m - 1, day));
  if (Number.isNaN(d.getTime())) return 'Date of birth is not a valid date.';
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== day) {
    return 'That date does not exist. Please check the day and the month.';
  }
  const now = new Date();
  if (d > now) return 'Date of birth cannot be in the future.';
  const thirteen = new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));
  if (d > thirteen) return 'Accounts require a minimum age of 13.';
  return null;
}

interface PostResult { status: number; ok: boolean; data: Record<string, string | boolean> }

async function postJson(url: string, body: unknown): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, ok: false, data: {} };
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, data: data as Record<string, string | boolean> };
}

// ── Small presentational pieces ──────────────────────────────────────────

function Field(
  { id, label, type = 'text', value, onChange, inputRef, className = '', ...rest }:
  {
    id: string; label: string; type?: string; value: string;
    onChange: (v: string) => void;
    /** So a caller can ask the element itself what it makes of its contents. */
    inputRef?: React.Ref<HTMLInputElement>;
    className?: string;
  } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id' | 'type'>,
) {
  return (
    <div className={`input-group ${className}`}>
      <input ref={inputRef} id={id} type={type} placeholder=" " value={value}
             onChange={(e) => onChange(e.target.value)} {...rest} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function PasswordField(
  { id, label, value, onChange, autoComplete, autoFocus, children }:
  {
    id: string; label: string; value: string; onChange: (v: string) => void;
    autoComplete?: string; autoFocus?: boolean; children?: React.ReactNode;
  },
) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-group">
      <div className="password-wrapper">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          placeholder=" "
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
        />
        <label htmlFor={id}>{label}</label>
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {shown ? <EyeClosed /> : <EyeOpen />}
        </button>
      </div>
      {children}
    </div>
  );
}

function SubmitButton(
  { loading, busyLabel, children }:
  { loading: boolean; busyLabel: string; children: React.ReactNode },
) {
  return (
    <button type="submit" className="btn-primary" disabled={loading}>
      {loading && <span className="spinner" />}
      {loading ? busyLabel : children}
    </button>
  );
}

// The read-only email plus "Use a different email". On EVERY screen past the
// first, so the address being signed in is always on the screen that acts on it.
function AccountRow({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  return (
    <div className="account-row">
      <p className="account-email" title={email}>{email}</p>
      <button type="button" className="use-different" onClick={onChangeEmail}>
        Use a Different Email Address
      </button>
    </div>
  );
}

function ErrorAlert({ message }: { message: string }) {
  if (!message) return null;
  return <div className="auth-alert auth-alert--error" role="alert">{message}</div>;
}

// Module level, so it can see nothing declared inside JubileeIdDoor. The setters
// arrive already wrapped by the parent -- referencing a closure from there is a
// ReferenceError at RENDER time, which compiles cleanly and then takes the whole
// screen down.
function NameFields(
  { firstName, lastName, setFirstName, setLastName }:
  {
    firstName: string; lastName: string;
    setFirstName: (v: string) => void; setLastName: (v: string) => void;
  },
) {
  return (
    <div className="form-row">
      <Field id="firstName" label="First name" value={firstName} onChange={setFirstName}
             maxLength={50} autoComplete="given-name" />
      <Field id="lastName" label="Last name" value={lastName} onChange={setLastName}
             maxLength={50} autoComplete="family-name" />
    </div>
  );
}

// A date input never shows a placeholder, so its label is parked in the raised
// position from the start (.label-up).
function DobField(
  { dob, setDob, inputRef }:
  { dob: string; setDob: (v: string) => void; inputRef: React.Ref<HTMLInputElement> },
) {
  return (
    <Field id="dob" label="Date of birth" type="date" value={dob} onChange={setDob}
           inputRef={inputRef}
           className="date-field label-up" autoComplete="bday" max="9999-12-31" />
  );
}

function RememberRow(
  { checked, onChange }: { checked: boolean; onChange: (v: boolean) => void },
) {
  return (
    <div className="remember-row">
      <label className="checkbox-wrapper">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>Keep me signed in on this device</span>
      </label>
    </div>
  );
}

type Step = 'email' | 'welcome' | 'form' | 'success';

// ── The door ─────────────────────────────────────────────────────────────
// The query string is parsed on the server (lib/door-params.ts) and arrives as
// props, so the first response already contains the sign-in screen rather than
// an empty shell for the client to fill in.
export default function JubileeIdDoor(
  { returnUrl = '/', initialEmail = '', initialError = '', configWarning = '' }:
  { returnUrl?: string; initialEmail?: string; initialError?: string; configWarning?: string },
) {
  const router = useRouter();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState(initialEmail);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  // The date input itself, so validateDob can ask it rather than infer.
  //
  // A ref, NOT state fed from onChange: while the box holds an impossible date
  // its value stays the empty string, so no input event fires and an onChange
  // handler is never called. The element is asked at submit, when the answer is
  // needed and is certainly current.
  const dobRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [existingPassword, setExistingPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);

  // Screens past the first are steps, not documents, so Back has to be taught
  // what a step is or it would leave the site from the middle of a sign-up.
  const pushedState = useRef(false);
  useEffect(() => {
    if (step === 'email' || step === 'success') return undefined;
    if (!pushedState.current) {
      window.history.pushState({ doorStep: step }, '');
      pushedState.current = true;
    }
    const onPop = () => { pushedState.current = false; useDifferentEmail(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const goto = useCallback((next: Step) => { setError(''); setStep(next); }, []);

  // Editing a field answers the complaint about it. Leaving the old message up
  // contradicts what the person is now looking at.
  const edit = (set: (v: string) => void) => (v: string) => { set(v); if (error) setError(''); };

  function useDifferentEmail() {
    setExistingPassword('');
    setPassword('');
    setConfirmPassword('');
    setFirstName('');
    setLastName('');
    setDob('');
    goto('email');
  }

  // The session is set by the server as an httpOnly cookie, so there is nothing
  // to store here -- see lib/sso-door.ts for why this is the one place the port
  // diverges from kJubilee, which writes the token to localStorage.
  //
  // router.refresh() before the push: the destination is a server component that
  // has already been rendered signed-out in this router's cache, and without it
  // the reader lands on a page still showing "Sign in".
  function signedIn() {
    router.refresh();
    router.push(returnUrl);
  }

  // ── Screen 1 → look the email up, then route to A or C ────────────────
  async function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return setError('Please enter your email address to continue.');
    if (!EMAIL_RE.test(addr)) {
      return setError('That does not look like a complete email address. Please check it.');
    }

    setEmail(addr);
    setError('');
    setLoading(true);
    const r = await postJson('/api/sso/signup/lookup', { email: addr });
    setLoading(false);

    if (!r.ok || !r.data.success) {
      return setError(String(r.data.error
        || 'We are having trouble reaching your account right now. Please try again in a moment.'));
    }
    return goto(r.data.existsInSso ? 'welcome' : 'form');
  }

  // ── Outcome A — verify the password and sign in ──────────────────────
  async function handleWelcomePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!existingPassword) return setError('Please enter your password.');
    setError('');
    setLoading(true);
    const r = await postJson('/api/sso/login', { email, password: existingPassword, rememberMe });
    setLoading(false);

    if (r.data.success) return signedIn();
    return setError(String(r.data.error || 'That password does not match. Try again.'));
  }

  // ── Outcome C — create the Jubilee ID ────────────────────────────────
  async function handleCreateJubileeId(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return setError('Please enter your first and last name.');
    const dobErr = validateDob(dob, dobRef.current?.validity.badInput === true);
    if (dobErr) return setError(dobErr);
    if (!password || password.length < 8) return setError('Password must be at least 8 characters.');
    // Creating a Jubilee ID is the one screen where a typo is expensive: it
    // becomes the password for every Jubilee site, and nothing here reads it
    // back to confirm. Everywhere else the password is being CHECKED, so a typo
    // just fails and is retried.
    if (password !== confirmPassword) return setError('Those passwords do not match.');

    setError('');
    setLoading(true);
    const r = await postJson('/api/sso/signup/register', {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email,
      date_of_birth: dob,
      password,
      rememberMe,
    });
    setLoading(false);

    if (r.data.success) return goto('success');
    if (r.status === 409) {
      // The email gained a Jubilee ID between Screen 1 and here. Send them to
      // the password screen with the address they already typed.
      setPassword('');
      setConfirmPassword('');
      setStep('welcome');
      return setError('An account already exists for this email — please sign in.');
    }
    return setError(String(r.data.error || 'Could not create your account. Please try again.'));
  }

  const strength = password ? calcStrength(password) : null;

  return (
    <AuthShell>
      {configWarning && (
        <div className="auth-alert auth-alert--notice" role="status">{configWarning}</div>
      )}

      {/* ── Screen 1: the one door — email only ── */}
      {step === 'email' && (
        <>
          {/* §1 of the door standard: the wordmark's own face, uppercase, in
              CSS rather than typed into the string so a screen reader is handed
              an ordinary sentence. */}
          <h1 className="door-heading door-heading--caps">Sign in with your Jubilee ID</h1>
          <p className="door-helper">One Jubilee ID works across all our sites</p>
          <ErrorAlert message={error} />

          {/* Kept from the sign-in page this replaces. §16 makes sign-in
              optional and §17 records a signed-in search against a Jubilee ID;
              matching kJubilee exactly would have quietly dropped that
              disclosure from the one screen where it is the decision. */}
          <ul className="door-ledger">
            <li className="yes"><span className="mark">+</span><span>300 searches a minute instead of 60.</span></li>
            <li className="yes"><span className="mark">+</span><span>Admin and review screens, if your Jubilee ID carries the right.</span></li>
            <li className="cost"><span className="mark">−</span><span>Your searches are stored with your Jubilee ID instead of anonymously.</span></li>
          </ul>

          <form onSubmit={handleEmailContinue} noValidate>
            <Field id="email" label="Email address" type="email" value={email}
                   onChange={setEmail} required maxLength={254}
                   autoComplete="email" autoFocus />
            <SubmitButton loading={loading} busyLabel="Checking…">Continue</SubmitButton>
            <p className="door-disclaimer">No account yet? We&rsquo;ll set one up for you.</p>
          </form>
        </>
      )}

      {/* ── Screen 2A: Welcome back ── */}
      {step === 'welcome' && (
        <>
          <h1 className="door-heading door-heading--caps">Welcome back</h1>
          <ErrorAlert message={error} />
          <AccountRow email={email} onChangeEmail={useDifferentEmail} />
          <form onSubmit={handleWelcomePassword} noValidate>
            <PasswordField id="existingPassword" label="Password"
                           value={existingPassword} onChange={edit(setExistingPassword)}
                           autoComplete="current-password" autoFocus />
            <RememberRow checked={rememberMe} onChange={setRememberMe} />
            <SubmitButton loading={loading} busyLabel="Signing in…">Continue</SubmitButton>
          </form>
        </>
      )}

      {/* ── Screen 2C: Let's create your Jubilee ID ── */}
      {step === 'form' && (
        <>
          <h1 className="door-heading">Let&rsquo;s create your Jubilee ID</h1>
          <p className="door-subtext">
            One account gives you access to {SITE_NAME} and everything else across
            Jubilee. It only takes a moment.
          </p>
          <ErrorAlert message={error} />
          <AccountRow email={email} onChangeEmail={useDifferentEmail} />
          <form onSubmit={handleCreateJubileeId} noValidate>
            <NameFields firstName={firstName} lastName={lastName}
                        setFirstName={edit(setFirstName)} setLastName={edit(setLastName)} />
            <DobField dob={dob} setDob={edit(setDob)} inputRef={dobRef} />
            <PasswordField id="password" label="Create a password"
                           value={password} onChange={edit(setPassword)}
                           autoComplete="new-password">
              {strength ? (
                <div className="password-strength">
                  <div className="strength-bar"><div className={`strength-fill ${strength}`} /></div>
                  <div className={`strength-text ${strength}`}>{STRENGTH_LABEL[strength]}</div>
                </div>
              ) : (
                <div className="password-hint">At least 8 characters</div>
              )}
            </PasswordField>
            <PasswordField id="confirmPassword" label="Confirm password"
                           value={confirmPassword} onChange={edit(setConfirmPassword)}
                           autoComplete="new-password">
              {confirmPassword && (
                <div className={`password-match ${password === confirmPassword ? 'is-match' : 'is-mismatch'}`}>
                  {password === confirmPassword ? 'Passwords match' : 'Passwords do not match'}
                </div>
              )}
            </PasswordField>
            <RememberRow checked={rememberMe} onChange={setRememberMe} />
            <p className="consent-line">
              By continuing, you agree to our{' '}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms of Use</a>
              {' '}and{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
            </p>
            <SubmitButton loading={loading} busyLabel="Creating…">Create my Jubilee ID</SubmitButton>
          </form>
        </>
      )}

      {/* ── Success ── */}
      {step === 'success' && (
        <div className="success-state">
          <div className="success-icon-circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <h2>You&rsquo;re all set!</h2>
          <p>Welcome to {SITE_NAME}. Your Jubilee ID is ready.</p>
          <button type="button" className="btn-primary" onClick={signedIn}>
            Start searching
          </button>
        </div>
      )}
    </AuthShell>
  );
}
