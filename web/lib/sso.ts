import 'server-only';

// ─────────────────────────────────────────────────────────────────────────
// Server-only client for the Jubilee ID (SSO) authority.
//
// Ported from kJubilee.com's `lib/sso.js` so the two sites speak the identical
// protocol. This module holds the client_id / client_secret and mints a
// short-lived service token, then calls the SSO API on behalf of JubileeSearch.
// NEVER import this from anything that ships to the browser.
//
// It replaces the OAuth 2.0 authorization-code + PKCE redirect flow this file
// used to hold. The family standard is the email-first door — a reader signs in
// without leaving the site — and two Jubilee properties should not implement
// two different protocols against the same authority.
//
// §14 still holds and is not weakened by the change: the Jubilee ID is the sole
// credential store. JubileeSearch keeps no user table, no password column and
// no reset flow. The password typed at the door is verified *at the authority*
// and never stored here.
// ─────────────────────────────────────────────────────────────────────────

const IS_DEV = (process.env.NODE_ENV || 'development') !== 'production';

export const SSO_BASE = (process.env.SSO_BASE
  || (IS_DEV ? 'http://localhost:4031' : 'https://sso.jubileeinspire.com')).replace(/\/+$/, '');

const CLIENT_ID = process.env.SSO_CLIENT_ID || 'jubileesearch';
const CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || '';

// The site key this door belongs to, sent with login/register so the authority
// can record which property the identity was used on.
export const SITE = process.env.SSO_SITE || 'jubileesearch';

// A request to the authority should fail fast rather than hang the sign-in form.
const TIMEOUT_MS = Number.parseInt(process.env.SSO_TIMEOUT_MS || '10000', 10);

// Cached in-process until shortly before it expires, so we do not mint one per
// sign-in.
let cachedToken: { token: string; exp: number } | null = null;

export function isConfigured(): boolean {
  return Boolean(CLIENT_SECRET);
}

export type SsoResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

// The renewal in proxy.ts runs inside a page request, so it may not wait the
// door's ten seconds: a slow authority must cost one render, not hang it.
const RENEW_TIMEOUT_MS = Number.parseInt(process.env.SSO_RENEW_TIMEOUT_MS || '3000', 10);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
}

async function getServiceToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.exp - 60_000 > now) return cachedToken.token;

  const res = await fetchWithTimeout(`${SSO_BASE}/api/auth/service/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`SSO service token mint failed: ${res.status}`);

  const data = (await res.json()) as { token: string; expiresAt?: string };
  const parsed = data.expiresAt ? Date.parse(data.expiresAt) : Number.NaN;
  cachedToken = { token: data.token, exp: Number.isNaN(parsed) ? now + 30 * 60_000 : parsed };
  return cachedToken.token;
}

/** All service calls return the same discriminated shape as kJubilee's client. */
async function callSso<T = Record<string, unknown>>(
  path: string, payload: unknown, timeoutMs = TIMEOUT_MS,
): Promise<SsoResult<T>> {
  if (!isConfigured()) {
    return { ok: false, status: 503, error: 'SSO_CLIENT_SECRET is not configured' };
  }

  let svc: string;
  try {
    svc = await getServiceToken();
  } catch {
    cachedToken = null;
    return { ok: false, status: 503, error: 'SSO authority unavailable' };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${SSO_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${svc}` },
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch {
    return { ok: false, status: 503, error: 'SSO authority unreachable' };
  }

  // Deliberately NOT clearing the cached service token on a 401. On these
  // endpoints a 401 means the PERSON's password was wrong, not ours -- and
  // evicting the token there would make every mistyped password mint a new
  // service token at the authority. The same holds for session/exchange: a
  // 401 there means the FAMILY SESSION is dead (revoked or expired), which is
  // an answer about the person, not about our service credential.
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    const err = (data as { error?: string } | null)?.error;
    return { ok: false, status: res.status, error: err || 'sso_error' };
  }
  return { ok: true, data: data as T };
}

// --- the identity calls the door makes -------------------------------------

export interface SsoUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null;
  /** What §14 gates the admin console on. Absent means no rights. */
  // Either shape: the authority sends an array, some deployments a
  // space- or comma-separated string. Both are read; anything else is no rights.
  rights?: string[] | string;
  roles?: string[] | string;
  groups?: string[] | string;
}

/**
 * The tokens the authority issues for a person.
 *
 * This is where JubileeSearch differs from kJubilee, and it is not cosmetic.
 * kJubilee mints its OWN HS256 token here (lib/auth.js `signJWT`) against a
 * local `kj_users` row. JubileeSearch has no user table to mint against, and
 * its engine verifies every bearer token at the authority (GET /api/auth/me,
 * engine/src/api/auth.js) -- so a locally minted token would be refused by
 * the engine, and the whole admin console with it.
 *
 * The authority's own access token is therefore what a sign-in keeps.
 */
export interface SsoTokens {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
  expires_at?: string;
}

/**
 * THE AUTHORITY DOES NOT SPEAK OAuth2, AND THIS IS WHERE THAT IS RECONCILED.
 *
 * `SsoTokens` above is the OAuth2 shape the rest of this door is written
 * against. The Jubilee authority answers /api/auth/login and /api/auth/register
 * with its own names instead:
 *
 *     { user, token, expiresAt }        not  { user, access_token, expires_at }
 *
 * Read straight through, `access_token` is therefore always undefined, and
 * respondSignedIn's guard turns a CORRECT password into
 * "Signed in, but no access token was issued" with a 503 — which is what every
 * sign-in on this site did until this adapter existed. The authority had
 * verified the password; only the field name was wrong.
 *
 * Normalising here, at the one place the authority's JSON enters, keeps that
 * knowledge in a single function: every caller downstream keeps reading
 * `access_token`, and if the authority ever grows real OAuth2 names this is the
 * only thing to delete. The original keys are left in place so nothing that
 * already reads `token` breaks.
 *
 * There is no refresh token: this authority issues none from these endpoints.
 * The 90-day family session opened separately is what outlives the access
 * token, not a refresh grant -- and `ssoExchangeSession` below is how a fresh
 * access token is obtained from it.
 */
type SsoUserTokens = { user: SsoUser } & SsoTokens;

/** The authority's own field names, which arrive alongside the OAuth2 ones. */
type JubileeTokenNames = { token?: string; expiresAt?: string };

function adoptJubileeTokens(result: SsoResult<SsoUserTokens>): SsoResult<SsoUserTokens> {
  if (!result.ok) return result;
  const d = result.data as SsoUserTokens & JubileeTokenNames;
  return {
    ok: true,
    data: {
      ...d,
      access_token: d.access_token ?? d.token ?? '',
      expires_at: d.expires_at ?? d.expiresAt,
      refresh_token: d.refresh_token ?? null,
    },
  };
}

/** Does this email have a Jubilee ID at all? */
export const ssoLookup = (email: string) =>
  callSso<{ exists: boolean }>('/api/auth/lookup', { email });

/** Verify { email, password } against the Jubilee ID authority. */
export const ssoLogin = async (email: string, password: string) =>
  adoptJubileeTokens(
    await callSso<{ user: SsoUser } & SsoTokens>('/api/auth/login', { email, password, site: SITE }),
  );

/** Create a brand-new Jubilee ID. 409 = the email already has one. */
export const ssoRegister = async (input: {
  first_name: string; last_name: string; email: string;
  date_of_birth?: string | null; password: string;
}) => adoptJubileeTokens(
  await callSso<{ user: SsoUser } & SsoTokens>('/api/auth/register', {
    ...input,
    date_of_birth: input.date_of_birth || null,
    site: SITE,
  }),
);

/**
 * Open a 90-day family session for someone this site has already proven.
 *
 * Best-effort, always. Signing in here is proof of identity for the whole
 * family, and the resulting session is what lets a plain link hand the reader to
 * a sibling site already signed in. Every failure returns null and the reader is
 * simply signed in to JubileeSearch alone: a sign-in that already succeeded must
 * never be turned into an error by the part that is a convenience.
 */
export const ssoOpenSession = (email: string) =>
  callSso<{ sessionToken: string }>('/api/auth/session/open', { email, site: SITE });

/** What session/exchange adds to the login shape: the family session's own expiry, after sliding. */
export type SsoExchange = { user: SsoUser } & SsoTokens & { session?: { expiresAt?: string } };

/**
 * A fresh access token for the person behind a live family session.
 *
 * This is what makes "Keep me signed in on this device" true. The authority's
 * access token lasts about fifteen minutes and it issues no refresh token; the
 * 90-day family session is the only credential that outlives it. proxy.ts calls
 * this when the sealed token is expired or about to be, and re-seals the answer.
 *
 * Authority contract (POST /api/auth/session/exchange, service-token gated):
 *   { sessionToken, site }  ->  200 { user, token, expiresAt, session: { expiresAt } }
 *                               401 { error: 'session_invalid' }  revoked, expired or unknown
 * The token is an ordinary user token, so GET /api/auth/me -- and therefore the
 * engine -- accepts it unchanged. Answered with the same adapter as login.
 */
export const ssoExchangeSession = async (sessionToken: string) =>
  adoptJubileeTokens(
    await callSso<SsoExchange>('/api/auth/session/exchange', { sessionToken, site: SITE }, RENEW_TIMEOUT_MS),
  ) as SsoResult<SsoExchange>;

/**
 * Service-gated identity update BY EMAIL, as kJubilee's lib/sso.js does it.
 * Only ever called with the address of the session that is asking, so a caller
 * can change nobody's name but their own.
 */
export const ssoUpdateProfileByEmail = (
  email: string, patch: { first_name: string; last_name: string | null },
) => callSso<{ user?: SsoUser }>('/api/auth/service/profile', { email, ...patch });

/**
 * Set a new password on the identity behind a live session. The authority holds
 * the credential (§14), so this is the only place a change can land; nothing is
 * hashed or stored here.
 */
export const ssoChangePasswordByEmail = (email: string, newPassword: string) =>
  callSso('/api/auth/service/password', { email, new_password: newPassword });

/** End a family session (sign-out). Idempotent; an unknown token is not an error. */
export const ssoRevokeSession = (sessionToken: string) =>
  callSso('/api/auth/session/revoke', { sessionToken });

// --- turning an authority answer into a session ----------------------------

/**
 * §14: the right is granted by the authority and never inferred here.
 *
 * The same rule the engine applies in `src/api/auth.js`: a token with no rights
 * claim gets no rights. Nothing is granted locally, and an unrecognised shape
 * is read as "no rights" rather than as "assume yes".
 */
export function rightsFrom(user: SsoUser | undefined | null): string[] {
  if (!user) return [];
  for (const value of [user.rights, user.roles, user.groups]) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

export function displayName(user: SsoUser | undefined | null): string | null {
  if (!user) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

/** Seconds-since-epoch expiry for a token, defaulting to 15 minutes. */
export function expiresAt(tokens: SsoTokens): number {
  if (tokens.expires_at) {
    const t = Date.parse(tokens.expires_at);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
    return Math.floor(Date.now() / 1000) + tokens.expires_in;
  }
  return Math.floor(Date.now() / 1000) + 15 * 60;
}

/** Names what is missing, for the door to say so rather than fail vaguely. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.SSO_BASE && !IS_DEV) missing.push('SSO_BASE');
  if (!CLIENT_SECRET) missing.push('SSO_CLIENT_SECRET');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  return missing;
}
