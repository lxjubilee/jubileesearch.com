-- 034 — local mirror of the Jubilee identities that use this site.
--
-- §14 says admin rights come with "a Jubilee ID … never a separate password
-- system", and that still holds exactly: there is no password here, no token
-- minted here, and nothing in this table is used to authenticate anybody. The
-- authority remains the only thing that can say who someone is.
--
-- What this adds is the thing every other family property already has and this
-- one did not: a row per person, so the site can answer "who uses this" and has
-- somewhere to hang per-user data later. JubileeInspire keeps the same mirror
-- (its `users` table, password_hash NULL, linked by `jubilee_id`), and the
-- parity is the point — a member is one row in one shape across the family.
--
-- IT IS A MIRROR, NOT A RECORD. Every column except the timestamps is a copy of
-- something the authority owns and may change, so it is rewritten from the
-- authority on each sign-in and never edited here. If the two disagree, the
-- authority is right. Deleting a row loses nothing that cannot be refetched by
-- signing in again.

CREATE TABLE users (
    id             BIGSERIAL PRIMARY KEY,
    -- The authority's own users.id. The stable handle: an email can change,
    -- this cannot, so joins and per-user data hang off it rather than the address.
    jubilee_id     UUID        NOT NULL UNIQUE,
    email          TEXT        NOT NULL UNIQUE,
    first_name     TEXT,
    last_name      TEXT,
    display_name   TEXT        NOT NULL DEFAULT '',
    -- Proven at the authority, mirrored here so a report does not need a round
    -- trip to answer it. Promote-only upstream; never written TRUE from here.
    email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sign-in looks a person up by whichever the authority returned; the UNIQUE on
-- jubilee_id already indexes that side, so only the address needs its own.
CREATE INDEX users_email_idx ON users (lower(email));

-- "Who has used this site recently" is the one question this table exists to
-- answer cheaply.
CREATE INDEX users_last_seen_idx ON users (last_seen_at DESC);
