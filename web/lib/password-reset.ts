import 'server-only';
import { engineOrigin } from './api';
import { sendPasswordResetEmail } from './email';
import * as sso from './sso';

// ─────────────────────────────────────────────────────────────────────────
// Password reset — issuing and burning JubileeSearch's own one-time links.
//
// Ported from kJubilee's lib/password-reset.js. The two rules that matter are
// stated once:
//
//   1. Nothing here ever tells a caller whether an address has a Jubilee ID.
//      requestReset returns the same shape either way; only the mailbox learns
//      anything. Otherwise the reset form becomes an account enumerator that
//      does not even need a password guess.
//
//   2. The token is never stored. The engine writes only its SHA-256
//      (migration 035), so the table is useless to anyone who reads it.
//
// The web tier has no database, so the token store is the engine's, reached
// over the internal secret-gated endpoints in routes/password-resets.js. The
// authority is what actually takes the new password (§14): this site never
// holds one, so a reset that did not reach the authority would change nothing.
// ─────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS ?? 5000);

const UNAVAILABLE = 'Password reset is temporarily unavailable. Please try again in a moment.';

async function internal<T>(path: string, payload: unknown): Promise<T | null> {
  const secret = process.env.INTERNAL_API_SECRET ?? '';
  if (!secret) return null;
  try {
    const res = await fetch(`${engineOrigin()}/api/v1/password-resets/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Issue a reset link and email it, but only if the address has a Jubilee ID.
 * The return value is deliberately the same either way. `delivered` is for the
 * SERVER LOG, never for the response body.
 */
export async function requestReset(
  rawEmail: unknown, requestedIp: string,
): Promise<{ success: boolean; delivered: boolean; error?: string }> {
  const addr = String(rawEmail ?? '').trim().toLowerCase();
  const quiet = { success: true, delivered: false };
  if (!addr) return quiet;

  // The reset changes the password on the JUBILEE ID, so what matters is
  // whether one exists, not whether there is a membership here.
  if (!sso.isConfigured()) {
    console.warn(`[password-reset] ${addr}: no authority configured to ask`);
    return { success: false, delivered: false, error: 'lookup_failed' };
  }
  const found = await sso.ssoLookup(addr);
  if (!found.ok) {
    console.error('[password-reset] authority lookup failed:', found.status, found.error);
    return { success: false, delivered: false, error: 'lookup_failed' };
  }
  if (!found.data.exists) {
    console.warn(`[password-reset] ${addr} is not known at the authority; nothing sent`);
    return quiet;
  }

  const issued = await internal<{ issued: boolean; token?: string; minutes?: number }>(
    'issue', { email: addr, ip: requestedIp || null },
  );
  if (!issued) return { success: false, delivered: false, error: 'store_failed' };
  if (!issued.issued || !issued.token) {
    // Already holds its allowance of live links. Still say nothing: a caller
    // must not be able to tell this apart from success.
    console.warn(`[password-reset] ${addr} already holds its allowance of live links; not issuing another`);
    return quiet;
  }

  const sent = await sendPasswordResetEmail({ to: addr, token: issued.token, minutes: issued.minutes ?? 60 });
  if (!sent.success) {
    // The token exists but the mail did not go. Burn it rather than leaving a
    // live credential nobody can use.
    await internal('burn', { token: issued.token });
    console.error('[password-reset] send failed for', addr, '- token burned');
    return { success: false, delivered: false, error: 'send_failed' };
  }

  console.log(`[password-reset] link sent to ${addr} via ${sent.provider}`);
  return { success: true, delivered: true };
}

/** Look a token up without consuming it: the reset screen checks before it draws. */
export async function peekToken(token: string): Promise<{ valid: boolean; email?: string }> {
  if (!token) return { valid: false };
  const r = await internal<{ valid: boolean; email?: string }>('peek', { token });
  if (!r?.valid || !r.email) return { valid: false };
  return { valid: true, email: r.email };
}

/** Spend the token and set the new password at the authority. */
export async function completeReset(
  token: string, newPassword: string,
): Promise<{ success: true; email: string } | { success: false; error: string }> {
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters.' };
  }
  if (newPassword.length > 200) {
    return { success: false, error: 'That password is too long.' };
  }

  const peek = await peekToken(token);
  if (!peek.valid || !peek.email) {
    return { success: false, error: 'That reset link has expired or has already been used. Please request a new one.' };
  }
  const addr = peek.email;

  if (!sso.isConfigured()) {
    // Refusing is the honest answer: the credential lives at the authority and
    // we cannot reach it, so nothing done here would let this person sign in.
    return { success: false, error: UNAVAILABLE };
  }
  const r = await sso.ssoChangePasswordByEmail(addr, newPassword);
  if (!r.ok) {
    console.error('[password-reset] authority refused the change:', r.status, r.error);
    return { success: false, error: UNAVAILABLE };
  }

  // Burn this token AND every other outstanding one for the address.
  const consumed = await internal<{ consumed: boolean }>('consume', { token });
  if (!consumed?.consumed) {
    // The password IS changed. A link that outlives it is the only cost, and
    // it can set nothing the person did not just set themselves.
    console.error('[password-reset] could not burn tokens for', addr);
  }

  console.log(`[password-reset] password changed for ${addr} (jubilee id)`);
  return { success: true, email: addr };
}
