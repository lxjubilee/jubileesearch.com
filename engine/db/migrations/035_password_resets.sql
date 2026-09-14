-- 035 — one-time password-reset tokens, ported from kJubilee's
-- migrations/003-password-resets.sql.
--
-- Why this site owns these rather than the Jubilee ID authority: the authority
-- stores a reset code but does not email it -- "the requesting SITE owns the
-- reset UX". So the link is issued and sent from here, and the new password is
-- set on the Jubilee ID when the link is opened. §14 still holds: no password
-- is ever stored in this database. What is stored is the SHA-256 of a random
-- token, which is useless to anyone who reads the table, including us.
--
-- The web tier has no database, so it asks this service to issue, peek and
-- consume tokens over the internal, secret-gated endpoints in
-- src/api/routes/password-resets.js.

CREATE TABLE password_resets (
    id           BIGSERIAL PRIMARY KEY,
    email        TEXT        NOT NULL,
    token_hash   TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    requested_ip TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup on completion is by hash (the UNIQUE covers it); the live-count
-- and the burn-the-rest sweep are by email.
CREATE INDEX password_resets_email_idx ON password_resets (lower(email), created_at DESC);
