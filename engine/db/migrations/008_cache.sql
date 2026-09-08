-- 008 — the two-layer cache (R9, §7.9).
--
-- UNLOGGED is deliberate: cache contents are disposable and skipping the WAL
-- removes the write cost. A crash empties the cache and the system refills it.

CREATE UNLOGGED TABLE result_cache (
    cache_key     TEXT PRIMARY KEY,       -- hash of normalized query + filters + version
    payload       JSONB NOT NULL,
    hit_count     INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX result_cache_expiry_idx ON result_cache (expires_at);

CREATE UNLOGGED TABLE embedding_cache (
    query_hash    TEXT PRIMARY KEY,
    normalized    TEXT NOT NULL,
    embedding     halfvec(1024) NOT NULL,
    model_id      TEXT NOT NULL,
    hit_count     INT NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX embedding_cache_lru_idx ON embedding_cache (last_used_at);
