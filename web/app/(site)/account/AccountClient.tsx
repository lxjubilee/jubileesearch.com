'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PasswordField, { PasswordStrength, PasswordMatch } from '@/components/auth/PasswordField';

/*
 * The interactive half of /account. Ported from kJubilee's app/account/client.js
 * with the localStorage session and the email-confirmation card removed: the
 * session here is an httpOnly cookie the server has already read (see page.tsx),
 * and a Jubilee ID IS a confirmed address, so there is nothing to confirm.
 *
 * Three acts, in ascending order of consequence: save a name, change the
 * password, delete the membership. Each talks to its own route under
 * /api/account, which reads the session again before doing anything.
 */

export interface Account {
  name: string | null;
  first_name: string;
  last_name: string;
  email: string;
  role: 'admin' | 'viewer' | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

type Note = { kind: 'ok' | 'stop'; text: string } | null;

interface ApiResult { ok: boolean; status: number; data: Record<string, unknown> }

async function api(path: string, method: string, body?: unknown): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    // Offline, or the server is unreachable. Status 0 is the caller's cue to
    // say so rather than to report whatever the last state was.
    return { ok: false, status: 0, data: {} };
  }
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  return { ok: res.ok, status: res.status, data };
}

const OFFLINE = 'The server could not be reached. Check your connection and try again.';
const errorText = (r: ApiResult, fallback: string) =>
  r.status === 0 ? OFFLINE : (typeof r.data.error === 'string' ? r.data.error : fallback);

function longDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// "Sandeep Agarwal" -> "SA", the same disc the header shows.
function initials(name: string | null, email: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length >= 2 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  if (first) return (first + last).toUpperCase();
  return email.charAt(0).toUpperCase() || '?';
}

/** The result line under a form. Silent until there is something to say. */
function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p className={`acct-note acct-note--${note.kind}`} role={note.kind === 'stop' ? 'alert' : 'status'}>
      {note.text}
    </p>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="acct-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Card(
  { title, blurb, tone = '', children }:
  { title: string; blurb?: string; tone?: '' | 'stop'; children: React.ReactNode },
) {
  return (
    <section className={`acct-card${tone ? ' acct-card--' + tone : ''}`}>
      <h2 className="acct-card-title">{title}</h2>
      {blurb && <p className="acct-card-blurb">{blurb}</p>}
      {children}
    </section>
  );
}

function Field(
  { id, label, value, onChange, ...rest }:
  { id: string; label: string; value: string; onChange: (v: string) => void }
  & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>,
) {
  return (
    <div className="input-group">
      <input id={id} type="text" placeholder=" " value={value}
             onChange={(e) => onChange(e.target.value)} {...rest} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function Submit(
  { busy, busyLabel, tone = '', disabled = false, children }:
  { busy: boolean; busyLabel: string; tone?: '' | 'stop'; disabled?: boolean; children: React.ReactNode },
) {
  return (
    <button type="submit" className={`acct-btn${tone ? ' acct-btn--' + tone : ''}`} disabled={busy || disabled}>
      {busy ? busyLabel : children}
    </button>
  );
}

/* The identity strip: who this is, and the facts a settings page owes someone
   about their own account. The address is here rather than in an editable
   field because it is exactly the thing that cannot be edited. */
function Identity({ account }: { account: Account }) {
  return (
    <section className="acct-id">
      <span className="acct-avatar" aria-hidden="true">{initials(account.name, account.email)}</span>
      <div className="acct-who">
        <p className="acct-who-name">{account.name || 'No name set'}</p>
        <p className="acct-who-email">{account.email}</p>
        {account.role === 'admin' && <span className="acct-badge">Administrator</span>}
        {account.role === 'viewer' && <span className="acct-badge acct-badge--wait">Viewer</span>}
      </div>
      <dl className="acct-facts">
        <Fact label="Member since" value={longDate(account.first_seen_at)} />
        <Fact label="Last signed in" value={longDate(account.last_seen_at)} />
        <Fact label="Sign-in" value="Jubilee ID" />
      </dl>
    </section>
  );
}

export default function AccountClient({ account: initial }: { account: Account }) {
  const router = useRouter();
  const [account, setAccount] = useState(initial);
  const [gone, setGone] = useState(false);

  const [first, setFirst] = useState(initial.first_name);
  const [last, setLast] = useState(initial.last_name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameNote, setNameNote] = useState<Note>(null);

  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNote, setPwNote] = useState<Note>(null);

  const [dangerOpen, setDangerOpen] = useState(false);
  const [delWord, setDelWord] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delNote, setDelNote] = useState<Note>(null);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameNote(null);
    setNameBusy(true);
    const r = await api('/api/account', 'PATCH', { first_name: first, last_name: last });
    setNameBusy(false);

    if (!r.ok || r.data.success !== true) {
      setNameNote({ kind: 'stop', text: errorText(r, 'Your name could not be saved.') });
      return;
    }
    const user = r.data.user as { name: string; first_name: string; last_name: string };
    setAccount((prev) => ({ ...prev, name: user.name, first_name: user.first_name, last_name: user.last_name }));
    // The header's disc reads the cookie the route just rewrote; a refresh is
    // what makes it show the new initials without a full load.
    router.refresh();
    setNameNote({ kind: 'ok', text: 'Saved.' });
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwNote(null);
    if (newPw !== confirmPw) {
      setPwNote({ kind: 'stop', text: 'The two new passwords do not match.' });
      return;
    }
    setPwBusy(true);
    const r = await api('/api/account/password', 'POST', { newPassword: newPw });
    setPwBusy(false);

    if (!r.ok || r.data.success !== true) {
      setPwNote({ kind: 'stop', text: errorText(r, 'Your password could not be changed.') });
      return;
    }
    setNewPw(''); setConfirmPw('');
    setPwNote({ kind: 'ok', text: 'Your Jubilee ID password has been changed. Use it the next time you sign in on any Jubilee site.' });
  }

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDelNote(null);
    setDelBusy(true);
    const r = await api('/api/account/delete', 'POST', { confirm: delWord });
    setDelBusy(false);

    if (!r.ok || r.data.success !== true) {
      setDelNote({ kind: 'stop', text: errorText(r, 'Your account could not be deleted.') });
      return;
    }
    setGone(true);
    // The session cookie is gone; every server component on the page rendered
    // signed-in and has to be told.
    router.refresh();
  }

  if (gone) {
    return (
      <main className="acct">
        <div className="acct-farewell">
          <h1>Your JubileeSearch account has been deleted.</h1>
          <p>
            Your membership here is gone and this device has been signed out. Your Jubilee ID is
            untouched: it still signs you in everywhere else in the family, and you are welcome
            back here any time.
          </p>
          <p><a href="/">Back to search</a></p>
        </div>
      </main>
    );
  }

  return (
    <main className="acct">
      <header className="acct-head">
        <div>
          <p className="acct-eyebrow">Your account</p>
          <h1 className="acct-title">Profile settings</h1>
        </div>
        <Link className="acct-back" href="/">Back to search</Link>
      </header>

      <Identity account={account} />

      <Card
        title="Your name"
        blurb="This is the name every Jubilee site greets you by, so changing it here changes it there too."
      >
        <form className="acct-form" onSubmit={saveName}>
          <div className="acct-pair">
            <Field id="acct-first" label="First name" value={first} onChange={setFirst}
                   autoComplete="given-name" maxLength={80} required />
            <Field id="acct-last" label="Last name" value={last} onChange={setLast}
                   autoComplete="family-name" maxLength={80} />
          </div>
          <div className="acct-actions">
            <Submit busy={nameBusy} busyLabel="Saving…">Save name</Submit>
            <NoteLine note={nameNote} />
          </div>
        </form>
      </Card>

      <Card
        title="Email address"
        blurb="Your address is your Jubilee ID, and it is what your account and every sign-in are filed under. It is changed at your Jubilee ID rather than here."
      >
        <p className="acct-readonly">{account.email}</p>
        <span className="acct-badge">Confirmed</span>
      </Card>

      <Card
        title="Password"
        blurb="Your password lives with your Jubilee ID, so this changes the password you use on every Jubilee site."
      >
        <form className="acct-form" onSubmit={savePassword}>
          {/* No "current password" field: this screen is behind a live
              session, and asking someone to re-prove the sign-in they are
              standing in is a wall in front of the people least able to climb
              it. The door's forgotten-password path is for anyone who has
              actually lost it. */}
          <div className="acct-pair">
            <PasswordField id="acct-new" label="New password" value={newPw} onChange={setNewPw}
                           autoComplete="new-password" minLength={8}>
              <PasswordStrength value={newPw} />
            </PasswordField>
            <PasswordField id="acct-confirm" label="Confirm new password" value={confirmPw}
                           onChange={setConfirmPw} autoComplete="new-password" minLength={8}>
              <PasswordMatch password={newPw} confirm={confirmPw} />
            </PasswordField>
          </div>
          <div className="acct-actions">
            <Submit busy={pwBusy} busyLabel="Changing…">Change password</Submit>
            <NoteLine note={pwNote} />
          </div>
        </form>
      </Card>

      <Card
        title="Delete account"
        tone="stop"
        blurb="This removes your JubileeSearch membership. It cannot be undone."
      >
        <p className="acct-card-blurb">
          <strong>Your Jubilee ID is not deleted.</strong> It is your identity across every
          Jubilee site, and JubileeSearch has no business closing it. You would keep signing in
          elsewhere exactly as before, and could join JubileeSearch again whenever you liked.
        </p>

        {!dangerOpen && (
          <button type="button" className="acct-btn acct-btn--stop" onClick={() => setDangerOpen(true)}>
            Delete my JubileeSearch account
          </button>
        )}

        {dangerOpen && (
          <form className="acct-form" onSubmit={deleteAccount}>
            {/* The typed word is the only lock, and it is the right one: it
                catches the owner who did not mean it. DELETE cannot be typed
                by accident. */}
            <Field id="acct-del-confirm" label="Type DELETE to confirm" value={delWord}
                   onChange={setDelWord} autoComplete="off" spellCheck={false} required />
            <div className="acct-actions">
              <Submit busy={delBusy} busyLabel="Deleting…" tone="stop"
                      disabled={delWord.trim().toUpperCase() !== 'DELETE'}>
                Delete my account permanently
              </Submit>
              <button type="button" className="acct-btn acct-btn--quiet"
                      onClick={() => { setDangerOpen(false); setDelWord(''); setDelNote(null); }}>
                Keep my account
              </button>
              <NoteLine note={delNote} />
            </div>
          </form>
        )}
      </Card>

      <nav className="acct-footnav">
        <Link href="/">Search</Link>
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/terms">Terms of use</Link>
        {account.role && <Link href="/admin">Admin console</Link>}
      </nav>
    </main>
  );
}
