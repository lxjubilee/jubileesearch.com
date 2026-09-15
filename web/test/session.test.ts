// node --test test/   (Node 24 strips the types itself; no runner to install)
//
// The pure half of the session: sealing and the lifetime rules. The cookie
// plumbing in lib/session.ts and proxy.ts is exercised by hand against the dev
// authority (README, "Sessions"); what is asserted here is everything that
// would otherwise only be discovered thirty days later.

process.env.SESSION_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
process.env.SESSION_RENEW_WINDOW_S = '300';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../lib/session-crypto.ts';
import {
  shouldRenew, sessionCookieOptions, familyCookieOptions, isRemembered,
  SESSION_MAX_AGE_S, FAMILY_MAX_AGE_S, RENEW_WINDOW_S,
} from '../lib/session-policy.ts';

test('seal / unseal round-trips and rejects tampering', () => {
  const s = { a: 1, b: 'two' };
  const sealed = seal(s);
  assert.deepEqual(unseal(sealed), s);

  const [iv, tag, body] = sealed.split('.');
  const flipped = body![0] === 'A' ? 'B' : 'A';
  assert.equal(unseal(`${iv}.${tag}.${flipped}${body!.slice(1)}`), null);
  assert.equal(unseal('not.a.sealed.value.at.all'), null);
  assert.equal(unseal(undefined), null);
});

test('unseal with a different secret is not a session', () => {
  const sealed = seal({ x: 1 });
  const keep = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'another-secret-that-is-also-at-least-thirty-two-chars';
  try {
    assert.equal(unseal(sealed), null);
  } finally {
    process.env.SESSION_SECRET = keep;
  }
});

test('shouldRenew: none / renew / expired', () => {
  const now = 1_800_000_000;
  assert.equal(shouldRenew(null, now), 'none');
  assert.equal(shouldRenew({ expires_at: now + 3600 }, now), 'none');
  assert.equal(shouldRenew({ expires_at: now + RENEW_WINDOW_S }, now), 'none');      // boundary: not yet inside
  assert.equal(shouldRenew({ expires_at: now + RENEW_WINDOW_S - 1 }, now), 'renew');
  assert.equal(shouldRenew({ expires_at: now + 1 }, now), 'renew');
  assert.equal(shouldRenew({ expires_at: now }, now), 'expired');
  assert.equal(shouldRenew({ expires_at: now - 86400 }, now), 'expired');
});

test('remember drives the session cookie lifetime; absent means remembered', () => {
  assert.equal(isRemembered({ remember: true }), true);
  assert.equal(isRemembered({ remember: false }), false);
  assert.equal(isRemembered({}), true);
  assert.equal(isRemembered(null), true);

  assert.equal(sessionCookieOptions({ remember: true }, true).maxAge, SESSION_MAX_AGE_S);
  assert.equal(sessionCookieOptions({}, true).maxAge, SESSION_MAX_AGE_S);
  assert.equal('maxAge' in sessionCookieOptions({ remember: false }, true), false);

  const o = sessionCookieOptions({ remember: true }, false);
  assert.equal(o.secure, false);
  assert.equal(o.httpOnly, true);
  assert.equal(o.sameSite, 'lax');
  assert.equal(o.path, '/');
});

test('family cookie follows remember and never exceeds ninety days', () => {
  assert.equal('maxAge' in familyCookieOptions(false, true), false);
  assert.equal(familyCookieOptions(true, true).maxAge, FAMILY_MAX_AGE_S);
  assert.equal(familyCookieOptions(true, true, 3600).maxAge, 3600);
  assert.equal(familyCookieOptions(true, true, FAMILY_MAX_AGE_S * 4).maxAge, FAMILY_MAX_AGE_S);
  assert.equal(familyCookieOptions(true, true, -5).maxAge, 0);
});

test('a realistic session seals well under the cookie limit', () => {
  const session = {
    jubilee_id: '0123456789abcdef0123456789abcdef',
    name: 'Zev Inspire', first_name: 'Zev', last_name: 'Inspire',
    email: 'zev@jubileesearch.com',
    rights: ['search_admin', 'search_viewer'],
    access_token: 'x'.repeat(1024),
    refresh_token: null,
    expires_at: 1_800_000_000,
    remember: true,
  };
  assert.ok(seal(session).length < 3800);
});
