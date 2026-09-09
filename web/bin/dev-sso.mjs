#!/usr/bin/env node
/**
 * A stand-in Jubilee ID authority for development.
 *
 * The real one is sso.jubileeinspire.com (localhost:4031 in development), and
 * it is not something this checkout can run. This serves the same service API
 * that kJubilee.com's lib/sso.js calls, so the door can be driven end to end:
 *
 *   POST /api/auth/service/token   client_id + client_secret -> service token
 *   POST /api/auth/lookup          does this email have a Jubilee ID?
 *   POST /api/auth/login           verify a password, issue tokens
 *   POST /api/auth/register        create a Jubilee ID, issue tokens
 *   POST /api/auth/session/open    open a 90-day family session
 *   POST /api/auth/session/revoke  end one
 *   GET  /jwks.json                the key the ENGINE verifies against
 *
 * The last one is why this replaces bin/dev-idp.mjs rather than sitting beside
 * it. The engine verifies every bearer token against the authority's JWKS and
 * reads `search_admin` out of the claims, so the thing that mints access tokens
 * and the thing that publishes the verification key have to be the same
 * service. The old dev IdP served an OIDC redirect flow that no longer exists.
 *
 * The signatures are real RS256 over a key generated at startup, so the engine's
 * verification path is genuinely exercised -- a mock that skipped it would prove
 * nothing about whether sign-in actually works.
 *
 * Identities live in memory and are gone on restart. Two are seeded so there is
 * something to sign in as; anything registered through the door joins them.
 *
 *   node bin/dev-sso.mjs
 */

import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign as signData, timingSafeEqual } from 'node:crypto';

// Development only, and it refuses rather than trusts the operator: this issues
// tokens for any password it is told to accept.
if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error(`dev-sso.mjs refuses to run with NODE_ENV=${process.env.NODE_ENV}.`);
  process.exit(1);
}

const PORT = Number(process.env.SSO_PORT ?? 4031);
const ISSUER = process.env.SSO_ISSUER ?? `http://127.0.0.1:${PORT}`;
const AUDIENCE = process.env.SSO_AUDIENCE ?? 'jubileesearch';
const KID = 'dev-sso-1';

// The service clients allowed to call this. Any secret is accepted in
// development, but the client must at least present one -- that is the check the
// real authority makes, and a door with no secret configured should fail here
// rather than appear to work.
const CLIENTS = new Set(['jubileesearch', 'kjubilee']);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signJwt(claims, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = b64({ iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + seconds, ...claims });
  const sig = signData('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
    .toString('base64url');
  return `${header}.${payload}.${sig}`;
}

// --- identities --------------------------------------------------------------
// Seeded so `npm run dev:sso` gives something to sign in as immediately. The
// rights are what §14 gates the admin console on.
const users = new Map();
function seed(email, password, first, last, rights) {
  users.set(email, {
    id: createHash('sha256').update(email).digest('hex').slice(0, 32),
    email, password, first_name: first, last_name: last, rights,
    date_of_birth: '1990-01-01',
  });
}
seed('zev@jubileesearch.com', 'jubilee123', 'Zev', 'Inspire', ['search_admin']);
seed('viewer@jubileesearch.com', 'jubilee123', 'Vera', 'Viewer', ['search_viewer']);
seed('reader@jubileesearch.com', 'jubilee123', 'Ruth', 'Reader', []);

const serviceTokens = new Set();
const familySessions = new Map();

const publicUser = (u) => ({
  id: u.id, email: u.email,
  first_name: u.first_name, last_name: u.last_name,
  date_of_birth: u.date_of_birth,
  rights: u.rights,
});

function tokensFor(u) {
  return {
    access_token: signJwt({ sub: u.id, email: u.email, name: `${u.first_name} ${u.last_name}`, rights: u.rights }, 900),
    refresh_token: randomBytes(32).toString('base64url'),
    expires_in: 900,
  };
}

const send = (res, status, body) => {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
};

/** Constant-time, so a service token is not guessable a byte at a time. */
function knownServiceToken(header) {
  const token = String(header ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  for (const known of serviceTokens) {
    const a = Buffer.from(token);
    const b = Buffer.from(known);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url, ISSUER);
    const route = `${req.method} ${url.pathname}`;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }

    if (route === 'GET /jwks.json') return send(res, 200, { keys: [jwk] });

    if (route === 'GET /.well-known/openid-configuration') {
      return send(res, 200, { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
    }

    // --- minting a service token -------------------------------------------
    if (route === 'POST /api/auth/service/token') {
      if (!CLIENTS.has(body.client_id) || !body.client_secret) {
        return send(res, 401, { error: 'unknown client or missing secret' });
      }
      const token = randomBytes(32).toString('base64url');
      serviceTokens.add(token);
      return send(res, 200, {
        token,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }

    // Everything past here is service-gated, exactly as the real authority is.
    if (url.pathname.startsWith('/api/auth/') && !knownServiceToken(req.headers.authorization)) {
      return send(res, 401, { error: 'a valid service token is required' });
    }

    const email = String(body.email ?? '').trim().toLowerCase();

    if (route === 'POST /api/auth/lookup') {
      return send(res, 200, { exists: users.has(email) });
    }

    if (route === 'POST /api/auth/login') {
      const u = users.get(email);
      // One answer for "no such identity" and "wrong password": a different one
      // would confirm an address to anyone who asks.
      if (!u || u.password !== body.password) {
        return send(res, 401, { error: 'Invalid email or password' });
      }
      return send(res, 200, { user: publicUser(u), ...tokensFor(u) });
    }

    if (route === 'POST /api/auth/register') {
      if (users.has(email)) return send(res, 409, { error: 'An account already exists for this email.' });
      if (!body.password || String(body.password).length < 8) {
        return send(res, 400, { error: 'Password must be at least 8 characters.' });
      }
      const u = {
        id: randomBytes(16).toString('hex'),
        email,
        password: body.password,
        first_name: body.first_name ?? '',
        last_name: body.last_name ?? '',
        date_of_birth: body.date_of_birth ?? null,
        // A new Jubilee ID carries no rights. §14: the right is granted at the
        // authority, never by signing up somewhere.
        rights: [],
      };
      users.set(email, u);
      return send(res, 201, { user: publicUser(u), ...tokensFor(u) });
    }

    if (route === 'POST /api/auth/session/open') {
      if (!users.has(email)) return send(res, 404, { error: 'no such identity' });
      const sessionToken = randomBytes(32).toString('base64url');
      familySessions.set(sessionToken, email);
      return send(res, 200, { sessionToken, expiresIn: 90 * 24 * 3600 });
    }

    if (route === 'POST /api/auth/session/revoke') {
      familySessions.delete(String(body.sessionToken ?? ''));
      return send(res, 200, { revoked: true });   // idempotent
    }

    return send(res, 404, { error: `no route for ${route}` });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
Development Jubilee ID authority on ${ISSUER}

  service token   POST ${ISSUER}/api/auth/service/token
  jwks            GET  ${ISSUER}/jwks.json

Sign in with any of these (password: jubilee123):

  zev@jubileesearch.com       search_admin   — the admin console
  viewer@jubileesearch.com    search_viewer  — the console, read-only
  reader@jubileesearch.com    no rights      — 300 searches a minute, nothing else

Point the two apps at it:

  web/.env.local     SSO_BASE=${ISSUER}
                     SSO_CLIENT_ID=jubileesearch
                     SSO_CLIENT_SECRET=anything-in-development
  engine/.env        SSO_JWKS_URL=${ISSUER}/jwks.json
                     SSO_ISSUER_URL=${ISSUER}
                     SSO_AUDIENCE=${AUDIENCE}

Identities are in memory and go away when this stops.
`);
});
