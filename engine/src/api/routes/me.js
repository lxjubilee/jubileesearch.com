// The signed-in person's own record (§14).
//
// One endpoint, and it exists so the local mirror in migration 013 gets written
// without anybody being trusted to say who they are.
//
// THE CALLER PROVES THE IDENTITY, NOT THE CLAIM. The door could have posted the
// profile it just received and asked for a row to be written, guarded by a
// shared secret — that is how JubileeInspire does it, and it works because the
// two halves of JI are one deployment. Here the caller sends nothing but the
// bearer it already holds, and this service asks the authority who that is. The
// difference matters: a leaked internal secret would let anyone mint a row for
// any address, whereas a leaked bearer only ever writes the row of the person
// whose token leaked — and that person's session is the thing to revoke anyway.
//
// So the body is ignored. Everything written here came from GET /api/auth/me.

import { query } from '../../db.js';

const exact = (path) => (p) => p === path;

const displayName = (p) =>
  [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || (p.email ?? '');

export const routes = [
  {
    // POST, not GET: it writes. The door calls it once per sign-in.
    method: 'POST', match: exact('/api/v1/me'),
    handle: async ({ identity }) => {
      if (!identity?.authenticated) {
        return { status: 401, body: { error: 'a Jubilee ID is required' } };
      }

      // Only the Jubilee path carries a profile; introspection and JWKS see
      // claims. Without one there is nothing truthful to mirror, so the row is
      // left alone rather than written with blanks over good data.
      const p = identity.profile;
      if (!p?.email) {
        return { status: 200, body: { jubilee_id: identity.jubilee_id, mirrored: false } };
      }

      // Keyed on jubilee_id, because that is the handle that cannot change. An
      // address that moves to another identity is therefore an UPDATE of the
      // row that owns it, not a duplicate — and the email UNIQUE would reject
      // the duplicate anyway, which is the behaviour we want to fail loudly.
      //
      // first_seen_at is never overwritten: the mirror may be rebuilt, but when
      // someone first arrived is a fact about them, not about the table.
      const { rows } = await query(
        `INSERT INTO users (jubilee_id, email, first_name, last_name, display_name, email_verified)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (jubilee_id) DO UPDATE
            SET email          = EXCLUDED.email,
                first_name     = EXCLUDED.first_name,
                last_name      = EXCLUDED.last_name,
                display_name   = EXCLUDED.display_name,
                -- Promote-only, mirroring the authority's own rule: a proof is
                -- never taken away by a later sign-in that happens to say less.
                email_verified = users.email_verified OR EXCLUDED.email_verified,
                last_seen_at   = now(),
                updated_at     = now()
          RETURNING jubilee_id, email, display_name, email_verified, first_seen_at, last_seen_at`,
        [identity.jubilee_id, p.email, p.first_name, p.last_name, displayName(p), p.email_verified === true],
      );

      return { status: 200, body: { ...rows[0], mirrored: true, rights: identity.rights } };
    },
  },
];
