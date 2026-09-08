-- 011 — split the vector index by zone.
--
-- §7.3 gives one HNSW index over every chunk in the corpus. That is correct as a
-- contract and wrong as a plan, because of how the two zones are retrieved.
--
-- Zone A searches T1 only and Zone B searches T2 and T3 (§13.1). With a single
-- index, "top 100 nearest T1 chunks" is served by walking the graph over the
-- whole corpus and discarding everything that is not T1 -- and at the v1 scale
-- target of 3 million chunks, T1 is the small side. HNSW returns its ef
-- candidates and *then* the filter runs, so a Zone A search on a corpus that is
-- mostly open web can come back with far fewer than 100 T1 chunks, or none.
-- Over-fetching papers over it; it does not fix it. This is the standard
-- filtered-ANN failure and it gets worse as T3 grows, which is precisely the
-- direction this index is going.
--
-- So `tier` is denormalised onto chunks and the index is split in two along the
-- zone boundary. Each zone then walks a graph containing only its own
-- candidates. Servability (status, safety verdict, suppression) is still
-- post-filtered through servable_pages, which is why retrieval over-fetches --
-- but tier, the one predicate that partitions the corpus, is now structural.
--
-- The denormalised column is maintained by trigger and is never written by
-- application code. A page that changes tier rewrites its chunks' tier in the
-- same transaction.

ALTER TABLE chunks ADD COLUMN tier trust_tier;

UPDATE chunks c SET tier = p.tier FROM pages p WHERE p.id = c.page_id;

CREATE FUNCTION chunks_inherit_tier() RETURNS TRIGGER AS $fn$
BEGIN
    SELECT p.tier INTO NEW.tier FROM pages p WHERE p.id = NEW.page_id;
    RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE TRIGGER chunks_tier_trigger
    BEFORE INSERT OR UPDATE OF page_id ON chunks
    FOR EACH ROW EXECUTE FUNCTION chunks_inherit_tier();

CREATE FUNCTION pages_cascade_tier() RETURNS TRIGGER AS $fn$
BEGIN
    IF NEW.tier IS DISTINCT FROM OLD.tier THEN
        UPDATE chunks SET tier = NEW.tier WHERE page_id = NEW.id;
    END IF;
    RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE TRIGGER pages_tier_cascade
    AFTER UPDATE OF tier ON pages
    FOR EACH ROW EXECUTE FUNCTION pages_cascade_tier();

DROP INDEX chunks_embedding_hnsw;

CREATE INDEX chunks_embedding_zone_a ON chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE tier = 'T1';

CREATE INDEX chunks_embedding_zone_b ON chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE tier IN ('T2','T3');

-- T0 chunks are indexed by neither, which is the point: quarantine is never
-- searched, so it should not cost graph memory either.
