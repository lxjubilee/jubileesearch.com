import 'server-only';

// ─────────────────────────────────────────────────────────────────────────
// Cloudflare Turnstile — human verification on the door's first screen.
//
// Ported from kJubilee.com's `lib/turnstile.js`. JubileeSearch holds its own
// site key and secret, so the token is verified server-side and a request
// without a good one does not get an answer. Where a site holds no secret the
// widget is decoration and a script that skips it is not stopped; that is not
// the case here.
//
// ── Which way it fails ──────────────────────────────────────────────────
//
// Fail CLOSED on a missing or bad token. That is the whole point, and it is the
// case an attacker controls.
//
// Fail OPEN when CLOUDFLARE ITSELF is unreachable from this server. That is our
// outage, not the visitor's, and refusing every sign-in because siteverify timed
// out trades a small amount of spam for a total one. It is logged loudly so it
// cannot pass unnoticed.
//
// ⚠ The widget only renders on a hostname listed in the site key's Cloudflare
// allowlist. If jubileesearch.com (and localhost, for development) are not on
// it, the widget never paints, no token is ever produced, and with enforcement
// on NOBODY CAN SIGN IN. TURNSTILE_ENFORCE=false is the escape hatch for a box
// in that state — it keeps the widget visible but stops gating on it.
// ─────────────────────────────────────────────────────────────────────────

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Enforcement is on whenever a secret exists, unless explicitly switched off.
const ENFORCE = process.env.TURNSTILE_ENFORCE !== 'false';

const TIMEOUT_MS = Number.parseInt(process.env.TURNSTILE_TIMEOUT_MS || '8000', 10);

/**
 * The public half. Handed to the browser by the server pages; safe to expose,
 * which is exactly why the secret is read only here and never sent anywhere.
 */
export function siteKey(): string {
  return SITE_KEY;
}

/** Is a token actually required? False on a box with no secret, or with the switch off. */
export function isEnforced(): boolean {
  return Boolean(SECRET_KEY) && ENFORCE;
}

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
  degraded?: boolean;
  skipped?: boolean;
}

/**
 * Check one token with Cloudflare.
 *
 * Tokens are SINGLE USE — Cloudflare rejects a replay — so a caller that fails
 * for any other reason must have the widget reset before the next attempt.
 */
export async function verifyTurnstile(
  token: unknown,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (!isEnforced()) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing' };

  const body = new URLSearchParams({ secret: SECRET_KEY, response: String(token) });
  // Cloudflare treats 'unknown' as absent; never send a placeholder as an IP.
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  let data: { success?: boolean; 'error-codes'?: string[] } | null = null;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    data = await res.json();
  } catch (e) {
    // Our side of the wire broke. Let the person through and shout about it.
    console.error('[turnstile] siteverify unreachable — allowing the request:',
      e instanceof Error ? e.message : e);
    return { ok: true, degraded: true };
  }

  if (data?.success) return { ok: true };

  const codes = data?.['error-codes'] || [];
  // An invalid SECRET is our misconfiguration, not a failed human check, and it
  // would otherwise look identical to a bot in the logs.
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is wrong or missing — every check will fail');
  }
  return { ok: false, reason: codes.join(',') || 'failed' };
}

// What the browser is told when the check does not pass. Deliberately the same
// sentence whatever went wrong: the error codes are for our logs, and telling a
// script which of its guesses was closer is doing its work for it.
export const HUMAN_CHECK_FAILED = 'Please complete the human verification and try again.';
