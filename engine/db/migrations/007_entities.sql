-- 007 — entity panels (R10, §7.8).
-- Panel content is pulled from JubileePedia and stored verbatim. JubileeSearch
-- does not author or summarise it (P7). Panels are text only (P10).

CREATE TABLE entities (
    id            BIGSERIAL PRIMARY KEY,
    entity_key    TEXT NOT NULL UNIQUE,   -- 'shavuot', 'zev-inspire', 'chesed'
    entity_type   TEXT NOT NULL,          -- 'hebrew_word','feast','persona','book','concept','place'
    display_name  TEXT NOT NULL,
    summary       TEXT,                   -- sourced from JubileePedia, never generated here
    source_url    TEXT NOT NULL,          -- JubileePedia canonical URL
    facts         JSONB,                  -- ordered label/value pairs for the panel
    related_urls  JSONB,
    concept_id    BIGINT REFERENCES lexicon_concepts(id),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    synced_at     TIMESTAMPTZ
);

CREATE TABLE entity_aliases (
    entity_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias         TEXT NOT NULL,
    lang          TEXT,
    PRIMARY KEY (entity_id, alias, lang)
);
CREATE INDEX entity_aliases_alias_idx ON entity_aliases (alias);
