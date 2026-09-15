import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Cookie sealing, on its own so that proxy.ts and the tests can use it without
// pulling in `next/headers`. Nothing here is Next-specific: it is AES-256-GCM
// over JSON with a key derived from SESSION_SECRET.
//
// A secret is required. There is no development default and no fallback to a
// constant: a predictable key on a cookie that carries an access token is the
// same as no encryption, and it would be the kind of thing that ships because
// it worked locally.

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
