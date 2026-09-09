// JWT verification against a JWKS.
//
// This is the code path where a mistake admits a forged identity, so it is
// tested against real keys and real signatures rather than mocks: the test
// generates an RSA and an EC keypair, serves a JWKS from a local HTTP server,
// and mints tokens with node:crypto.
//
// The forgery cases matter more than the happy path. Each one below is a
// documented way JWT verification is got wrong in the wild.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHmac, sign as signData } from 'node:crypto';

import { verifyJwt, invalidateJwks } from '../src/api/jwt.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

let server;
let jwksUri;
let rsa;
let ec;
let jwksBody;
let jwksRequests = 0;

const ISSUER = 'https://id.jubilee.example';
const AUDIENCE = 'jubileesearch';

before(async () => {
  rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', use: 'sig', alg: 'RS256' };
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig', alg: 'ES256' };
  jwksBody = { keys: [rsaJwk, ecJwk] };

  server = createServer((req, res) => {
    jwksRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwksBody));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  jwksUri = `http://127.0.0.1:${server.address().port}/jwks.json`;
});

after(() => new Promise((r) => server.close(r)));

/** Mint a genuinely signed token. */
function mint({
  alg = 'RS256', kid = 'rsa-1', claims = {}, key = rsa.privateKey, hash = 'sha256', dsa,
} = {}) {
  // kid: null omits it. Passing undefined would not: a destructuring default
  // fires on undefined, so { kid = 'rsa-1' } would put the default straight back.
  const header = b64(kid ? { alg, kid, typ: 'JWT' } : { alg, typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    sub: 'jubilee|zev', iss: ISSUER, aud: AUDIENCE,
    exp: now + 3600, iat: now, ...claims,
  });
  const signing = Buffer.from(`${header}.${payload}`);
  const signature = signData(hash, signing, dsa ? { key, dsaEncoding: dsa } : key);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

// A function, not an object literal: the literal would be evaluated at module
// load, before before() has assigned jwksUri, and every verification would fail
// with "Failed to parse URL from undefined".
const opts = () => ({ jwksUri, issuer: ISSUER, audience: AUDIENCE });

describe('JWT verification', () => {
  test('accepts a correctly signed RS256 token', async () => {
    const claims = await verifyJwt(mint(), opts());
    assert.ok(claims, 'a valid token was rejected');
    assert.equal(claims.sub, 'jubilee|zev');
  });

  test('accepts ES256 with the ieee-p1363 encoding providers actually emit', async () => {
    const token = mint({ alg: 'ES256', kid: 'ec-1', key: ec.privateKey, dsa: 'ieee-p1363' });
    const claims = await verifyJwt(token, opts());
    assert.ok(claims, 'a valid ES256 token was rejected');
  });

  test('rejects a tampered payload', async () => {
    const token = mint();
    const [header, , signature] = token.split('.');
    const forged = b64({ sub: 'jubilee|attacker', iss: ISSUER, aud: AUDIENCE, exp: Date.now() / 1000 + 3600 });
    assert.equal(await verifyJwt(`${header}.${forged}.${signature}`, opts()), null);
  });

  test('rejects "alg": "none"', async () => {
    // The oldest JWT forgery there is: drop the signature and claim the token
    // is unsigned.
    const header = b64({ alg: 'none', kid: 'rsa-1', typ: 'JWT' });
    const payload = b64({ sub: 'jubilee|attacker', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal(await verifyJwt(`${header}.${payload}.`, opts()), null);
  });

  test('rejects HS256 signed with the public key as the secret', async () => {
    // Algorithm confusion. The RSA public key is, by definition, public; if the
    // verifier honours HS256 it will accept an HMAC computed with that key as
    // the shared secret. The allow-list is asymmetric-only precisely for this.
    const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
    const header = b64({ alg: 'HS256', kid: 'rsa-1', typ: 'JWT' });
    const payload = b64({ sub: 'jubilee|attacker', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 });
    const mac = createHmac('sha256', publicPem).update(`${header}.${payload}`).digest('base64url');
    assert.equal(await verifyJwt(`${header}.${payload}.${mac}`, opts()), null);
  });

  test('rejects a token signed by a key that is not in the JWKS', async () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = mint({ key: stranger.privateKey });
    assert.equal(await verifyJwt(token, opts()), null);
  });

  test('rejects an expired token', async () => {
    const token = mint({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } });
    assert.equal(await verifyJwt(token, opts()), null);
  });

  test('allows a minute of clock skew rather than failing on the second', async () => {
    const token = mint({ claims: { exp: Math.floor(Date.now() / 1000) - 10 } });
    assert.ok(await verifyJwt(token, opts()), 'ten seconds past expiry should still pass');
  });

  test('rejects a token that is not yet valid', async () => {
    const token = mint({ claims: { nbf: Math.floor(Date.now() / 1000) + 600 } });
    assert.equal(await verifyJwt(token, opts()), null);
  });

  test('rejects the wrong issuer', async () => {
    const token = mint({ claims: { iss: 'https://id.somewhere-else.example' } });
    assert.equal(await verifyJwt(token, opts()), null);
  });

  test('rejects a token minted for another audience', async () => {
    // A token issued to a different Jubilee property is a valid token; it is
    // just not a token for this one.
    const token = mint({ claims: { aud: 'jubileepedia' } });
    assert.equal(await verifyJwt(token, opts()), null);
  });

  test('accepts an array audience that includes us', async () => {
    const token = mint({ claims: { aud: ['jubileepedia', AUDIENCE] } });
    assert.ok(await verifyJwt(token, opts()));
  });

  test('rejects a malformed token without throwing', async () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', '...']) {
      assert.equal(await verifyJwt(bad, opts()), null, `threw or accepted: ${bad}`);
    }
  });

  test('caches the JWKS rather than fetching per request', async () => {
    invalidateJwks();
    jwksRequests = 0;
    await verifyJwt(mint(), opts());
    await verifyJwt(mint(), opts());
    await verifyJwt(mint(), opts());
    assert.equal(jwksRequests, 1, 'the JWKS was refetched on every verification');
  });

  test('refetches once when a kid is unknown, in case keys rotated', async () => {
    invalidateJwks();
    await verifyJwt(mint(), opts());          // warms the cache
    jwksRequests = 0;

    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = mint({ kid: 'rsa-2', key: rotated.privateKey });
    await verifyJwt(token, opts());           // kid unknown -> one refetch
    assert.equal(jwksRequests, 1);

    // Now publish the rotated key and the same token verifies.
    jwksBody = {
      keys: [
        ...jwksBody.keys,
        { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rsa-2', use: 'sig', alg: 'RS256' },
      ],
    };
    invalidateJwks();
    assert.ok(await verifyJwt(token, opts()), 'a rotated key was not picked up');
  });

  test('a missing kid is only resolved when the choice is unambiguous', async () => {
    invalidateJwks();
    // The JWKS now holds three signing keys, so a token with no kid cannot be
    // matched without guessing -- and guessing is how a key meant for something
    // else ends up validating a signature.
    const token = mint({ kid: null });
    assert.equal(await verifyJwt(token, opts()), null);
  });
});
