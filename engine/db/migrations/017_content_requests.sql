-- 017 — content requests (§13.5 honest empty state, §10.3 gaps as writing work).
--
-- Zone A's empty state tells the reader: "The Jubilee network has not covered
-- this one yet. Tell us what you were looking for and we will pass it to the
-- writing team." Nothing received it. The link went to a page that did not
-- exist, so the one invitation the engine extends to a reader 404'd.
--
-- The zero-result *query* was already captured: `zeroResultGaps` in
-- crawl/discovery.js groups searches that returned nothing and surfaces the ones
-- seen three or more times in thirty days. That is a good signal and a poor
-- brief. "Tell me about bible" tells the writing team almost nothing; the same
-- reader saying "I wanted somewhere to start reading the Bible as an adult
-- convert" is a commission. This table holds the second kind.
--
-- **No identifier of any kind, deliberately.** Not the Jubilee ID, not the
-- session, not the IP. §17 forbids cross-site behavioural profiles and the
-- privacy notice promises no profile is built; a table pairing a person with
-- what they were hoping to read would be exactly that, and it would be far more
-- revealing than the search log it sits beside. The writing team needs the
-- request, never the requester. That also means there is nothing here for the
-- retention job to anonymise -- the row is born anonymous.
--
-- Nothing in this table is ever shown to another reader. It is an inbox for the
-- writing team, not user-generated content, so no moderation surface is implied
-- and P7 (no editorial fabrication) is untouched: a request is not an article.

CREATE TABLE content_requests (
    id          bigserial PRIMARY KEY,

    -- The search that came back empty, as the engine normalised it. Carried so
    -- a request can be read next to the query that prompted it.
    query_text  text NOT NULL,

    -- What the reader actually wanted, in their own words. Optional: some
    -- people will submit the bare query, and a request is still a signal.
    note        text,

    -- Detected on the search, not asked for. It decides which writer picks it up.
    lang        text,

    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The writing team reads this newest-first, and the discovery job aggregates a
-- recent window; both want the same ordering.
CREATE INDEX content_requests_recent_idx ON content_requests (created_at DESC);

COMMENT ON TABLE content_requests IS
  'Reader-submitted content gaps from the Zone A empty state. Deliberately holds no identifier: no jubilee_id, session_id or IP (spec 17).';
COMMENT ON COLUMN content_requests.note IS
  'Free text written by a reader. Treat as untrusted input; it is never rendered to other readers.';
