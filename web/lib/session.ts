import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

// The signed-in session.
//
// §14 is unambiguous about what this may not be: admin access requires "a
// Jubilee ID with the `search_admin` right, issued through the Jubilee SSO
// authority. **Never a separate password system.**" So there is no user table
// here, no password column, no hashing, no reset flow. This module holds what
// the SSO authority said about someone, for as long as it said it, and nothing
// else.
//
// The tokens live in an AES-256-GCM encrypted, httpOnly cookie and never reach
// the browser's JavaScript. That is the point of putting the session here
// rather than in localStorage: `lib/api.ts` attaches the access token to the
// server-side call to the engine, so a token is never in a place an XSS on any
// Jubilee property could read it.

const COOKIE = 'jubilee_session';
const FLOW_COOKIE = 'jubilee_auth_flow';
const FAMILY_COOKIE = 'jubilee_family';

/** What the SSO authority told us, plus the tokens to keep asking it. */
export interface Session {
  /** `sub` from the ID token. This is the jubilee_id §7.7 stores. */
  jubilee_id: string;
  name: string | null;
  email: string | null;
  rights: string[];
  access_token: string;
  refresh_token: string | null;
  /** Unix seconds. */
  expires_at: number;
}

/** The short-lived state that has to survive the redirect to the SSO. */
export interface AuthFlow {
  state: string;
  nonce: string;
  code_verifier: string;
  /** Where to send them once they are back. Same-origin paths only. */
  next: string;
}

// ---------------------------------------------------------------------------
// Cookie sealing
//
// A secret is required. There is no development default and no fallback to a
// constant: a predictable key on a cookie that carries an access token is the
// same as no encryption, and it would be the kind of thing that ships because
// it worked locally.
// ---------------------------------------------------------------------------
function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters before anyone can sign in. '
      + 'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }
  // HKDF rather than using the secret directly, so the same secret can derive
  // other keys later without them being related.
  return Buffer.from(hkdfSync('sha256', secret, 'jubilee-search-session', 'aes-256-gcm', 32));
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function unseal<T>(sealed: string | undefined): T | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv!);
    decipher.setAuthTag(tag!);
    const plain = Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    // A tampered, truncated or stale-key cookie is simply not a session. It is
    // never worth an error page: the reader is signed out, which is a state the
    // whole site already handles because search never requires sign-in.
    return null;
  }
}

// ---------------------------------------------------------------------------

const secure = process.env.NODE_ENV === 'production';

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const session = unseal<Session>(store.get(COOKIE)?.value);
  if (!session) return null;

  // An expired access token is not a session. `lib/sso.ts` refreshes ahead of
  // this where it can; reaching here with an expired one means the refresh
  // failed or there was no refresh token, and the honest answer is signed out.
  if (session.expires_at <= Math.floor(Date.now() / 1000)) return null;

  return session;
}

/**
 * @param rememberMe "Keep me signed in on this device", from the door.
 *
 * It is enforced where it actually counts -- the cookie's lifetime -- rather
 * than being a checkbox that changes nothing. Off means a session cookie that
 * dies with the browser; on means thirty days. kJubilee spends the same flag on
 * the token lifetime it mints; JubileeSearch does not mint tokens, so the cookie
 * carrying the authority's one is where the choice lands.
 */
export async function setSession(session: Session, rememberMe = true): Promise<void> {
  const store = await cookies();
  const value = seal(session);

  // Browsers drop a cookie over ~4KB silently, which would present as "sign-in
  // does nothing" with no error anywhere. Say so instead.
  if (value.length > 3800) {
    throw new Error(
      `The sealed session is ${value.length} bytes, which will not fit in a cookie. `
      + 'The access token from this SSO is too large to carry client-side; move the session '
      + 'to a server-side store keyed by an opaque cookie id.',
    );
  }

  store.set(COOKIE, value, {
    httpOnly: true,
    secure,
    // Lax, not Strict: a link arriving from a sibling Jubilee site is a
    // top-level GET, and Strict would withhold the cookie on exactly that
    // navigation.
    sameSite: 'lax',
    path: '/',
    // The cookie outlives the access token so a refresh can still happen; the
    // access token's own expiry is what getSession() enforces.
    ...(rememberMe ? { maxAge: 60 * 60 * 24 * 30 } : {}),
  });
}

/**
 * The Jubilee ID family session (§ kJubilee lib/family-session.js).
 *
 * A 90-day token from the authority saying this person is signed in across the
 * family. It is sealed exactly like the session and never readable by script:
 * what travels between sites is a one-time ticket minted from it, not this.
 */
export async function setFamilySession(token: string, rememberMe = true): Promise<void> {
  const store = await cookies();
  store.set(FAMILY_COOKIE, seal({ token, at: Date.now() }), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...(rememberMe ? { maxAge: 60 * 60 * 24 * 90 } : {}),
  });
}

export async function getFamilySession(): Promise<string | null> {
  const store = await cookies();
  return unseal<{ token: string }>(store.get(FAMILY_COOKIE)?.value)?.token ?? null;
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
  store.delete(FLOW_COOKIE);
  store.delete(FAMILY_COOKIE);
}

// ---------------------------------------------------------------------------
// The in-flight authorization request
// ---------------------------------------------------------------------------

export async function setAuthFlow(flow: AuthFlow): Promise<void> {
  const store = await cookies();
  store.set(FLOW_COOKIE, seal(flow), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    // Ten minutes is generous for "click the button, sign in, come back". A
    // longer window is a longer window for a stolen state parameter.
    maxAge: 600,
  });
}

export async function takeAuthFlow(): Promise<AuthFlow | null> {
  const store = await cookies();
  const flow = unseal<AuthFlow>(store.get(FLOW_COOKIE)?.value);
  // Single use, whatever happens next. A replayed callback must not find a
  // verifier waiting for it.
  store.delete(FLOW_COOKIE);
  return flow;
}

/** Constant-time comparison for the `state` parameter. */
export function sameState(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const RIGHTS = { admin: 'search_admin', viewer: 'search_viewer' } as const;

export const isAdmin = (s: Session | null) => Boolean(s?.rights.includes(RIGHTS.admin));
export const canView = (s: Session | null) => isAdmin(s) || Boolean(s?.rights.includes(RIGHTS.viewer));

/**
 * Only same-origin paths may be returned to after sign-in. Without this, an
 * `?next=https://elsewhere.example` turns the sign-in route into an open
 * redirect that borrows Jubilee's domain to look trustworthy.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}
