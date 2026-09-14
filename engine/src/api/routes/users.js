// Is this address a member HERE? (§14, and the family one-door.)
//
// A Jubilee ID says who someone is. It does not say they have an account on
// this site — those are different facts, and the door needs both to decide
// between "welcome back", "you have a Jubilee ID but are new here, so sign up",
// and "you are new everywhere". Only this service can answer the second half,
// because only this service has the users table.
//
// 🔴 THIS IS AN ENUMERATION ORACLE AND IS THEREFORE NOT PUBLIC.
//
// api.jubileesearch.com is reachable from the internet. An open "does this
// address have an account" endpoint would let anyone confirm membership one
// address at a time, for free, for the whole user base — which is exactly the
// thing the door's own lookup is rate-limited and captcha-gated to prevent, so
// leaving the back door open would make that front-door protection pointless.
//
// The caller is the door's server, never a browser, so it can hold a shared
// secret. Compared in constant time: a timing-variable compare on a fixed-length
// secret is a real oracle, not a theoretical one.
//
// Unset secret = refuse everything. A deployment that forgets the variable
// gets a door that cannot classify anyone, which is visible immediately —
// rather than an endpoint that quietly answers the world.

import { timingSafeEqual } from 'node:crypto';
import { query } from '../../db.js';

const exact = (path) => (p) => p === path;

function authorised(req) {
  const expected = process.env.INTERNAL_API_SECRET ?? '';
  if (!expected) return false;
  const got = req.headers['x-internal-secret'] ?? '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const routes = [
  {
    // POST so the address stays out of access logs, proxy caches and Referer
    // headers. It is a question, not a mutation, but a query string carrying
    // someone's email is written down in more places than a body is.
    method: 'POST', match: exact('/api/v1/users/lookup'),
    // The door is already throttled and captcha-gated in front of this, and a
    // second limiter keyed on the server's own IP would throttle every visitor
    // together the moment one of them retried.
    rateLimit: false,
    handle: async ({ req, body }) => {
      if (!authorised(req)) {
        // Deliberately indistinguishable from a wrong secret: a caller learns
        // nothing about whether the endpoint exists or the secret is merely bad.
        return { status: 404, body: { error: 'not found' } };
      }

      const email = String(body.parsed?.email ?? '').trim().toLowerCase();
      if (!email) return { status: 400, body: { error: 'email is required' } };

      // lower(email) matches the users_email_idx built for exactly this lookup.
      const { rows } = await query(
        'SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1', [email],
      );
      return { status: 200, body: { exists: rows.length > 0 } };
    },
  },
];
