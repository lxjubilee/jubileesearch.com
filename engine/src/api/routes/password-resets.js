// One-time password-reset tokens (migration 035), for the web tier's reset flow.
//
// Ported from kJubilee's lib/password-reset.js, split in two: the web tier
// still talks to the mailbox and the Jubilee ID authority, and only the part
// that needs a database -- issuing, checking and spending tokens -- lives here.
//
// Every endpoint is gated on INTERNAL_API_SECRET, like users/lookup, because
// api.jubileesearch.com is public and an open token mint is a way to reset
// anybody's password. The web tier, not this service, decides whether an
// address deserves a token; this only records and later honours the decision.
//
// The token itself is generated here and returned ONCE, to the caller that
// asked for it. Only its SHA-256 is written.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../../db.js';

const exact = (path) => (p) => p === path;

const TTL_MINUTES = Number.parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? '60', 10);
// How many live tokens one address may hold. Someone hammering "send me a
// link" should not be able to fill the table or an inbox on our budget.
const MAX_LIVE_PER_EMAIL = Number.parseInt(process.env.PASSWORD_RESET_MAX_LIVE ?? '3', 10);

function authorised(req) {
  const expected = process.env.INTERNAL_API_SECRET ?? '';
  if (!expected) return false;
  const got = req.headers['x-internal-secret'] ?? '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Deliberately indistinguishable from a wrong secret.
const NOT_FOUND = { status: 404, body: { error: 'not found' } };

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const normalize = (v) => String(v ?? '').trim().toLowerCase();

/** A live token's email, or null. Shared by peek and consume. */
async function liveEmail(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT email FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0]?.email ?? null;
}

export const routes = [
  {
    // Mint a token for an address the web tier has already vetted. Answers
    // { issued: false } rather than an error when the address already holds
    // its allowance -- the caller must still tell the person "check your
    // inbox", or the count becomes an oracle.
    method: 'POST', match: exact('/api/v1/password-resets/issue'),
    auth: false, rateLimit: false,
    handle: async ({ req, body }) => {
      if (!authorised(req)) return NOT_FOUND;
      const email = normalize(body.parsed?.email);
      if (!email) return { status: 400, body: { error: 'email is required' } };

      const { rows: [{ live }] } = await query(
        `SELECT COUNT(*)::int AS live FROM password_resets
          WHERE lower(email) = $1 AND used_at IS NULL AND expires_at > now()`,
        [email],
      );
      if (live >= MAX_LIVE_PER_EMAIL) {
        return { status: 200, body: { issued: false, reason: 'allowance' } };
      }

      // 32 bytes: not guessable, and short enough to survive a mail client's
      // line wrapping inside a URL.
      const token = randomBytes(32).toString('base64url');
      await query(
        `INSERT INTO password_resets (email, token_hash, expires_at, requested_ip)
              VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
        [email, hashToken(token), String(TTL_MINUTES), body.parsed?.ip ? String(body.parsed.ip) : null],
      );
      return { status: 200, body: { issued: true, token, minutes: TTL_MINUTES } };
    },
  },
  {
    // Is this link still good? Asked before the new-password screen is drawn.
    method: 'POST', match: exact('/api/v1/password-resets/peek'),
    auth: false, rateLimit: false,
    handle: async ({ req, body }) => {
      if (!authorised(req)) return NOT_FOUND;
      const email = await liveEmail(body.parsed?.token);
      return { status: 200, body: email ? { valid: true, email } : { valid: false } };
    },
  },
  {
    // Spend the token. Burns it AND every other outstanding one for the
    // address: whoever just proved they reach the mailbox has finished, and a
    // second live link is only useful to someone who should not have one.
    // Called by the web tier AFTER the authority accepted the new password, so
    // a refused change never costs the person their link.
    method: 'POST', match: exact('/api/v1/password-resets/consume'),
    auth: false, rateLimit: false,
    handle: async ({ req, body }) => {
      if (!authorised(req)) return NOT_FOUND;
      const email = await liveEmail(body.parsed?.token);
      if (!email) return { status: 200, body: { consumed: false } };
      await query(
        `UPDATE password_resets SET used_at = now()
          WHERE lower(email) = lower($1) AND used_at IS NULL`,
        [email],
      );
      return { status: 200, body: { consumed: true, email } };
    },
  },
  {
    // Burn one token without completing anything: the mail did not go, so a
    // live credential nobody can use must not be left behind.
    method: 'POST', match: exact('/api/v1/password-resets/burn'),
    auth: false, rateLimit: false,
    handle: async ({ req, body }) => {
      if (!authorised(req)) return NOT_FOUND;
      const token = body.parsed?.token;
      if (!token) return { status: 400, body: { error: 'token is required' } };
      await query(
        'UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL',
        [hashToken(token)],
      );
      return { status: 200, body: { burned: true } };
    },
  },
];
