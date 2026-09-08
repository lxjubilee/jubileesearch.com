// JubileePedia entity sync (R10, §7.8, §16).
//
// §16: "Source of truth for entity panels (R10). A sync job pulls entity
// summaries, facts, and canonical URLs into `entities`."
//
// The word that governs this file is **verbatim**. §7.8: "Panel content is
// pulled from JubileePedia and stored verbatim. JubileeSearch does not author or
// summarize it." So nothing here rewrites, truncates to a nicer length,
// title-cases, or fills a missing summary with the first sentence of something
// else. What JubileePedia says is what the panel shows, and if JubileePedia says
// nothing the panel has no summary.
//
// That is P7 applied to a place it would be very easy to break: an entity panel
// with a slightly-too-long summary is exactly the kind of thing a well-meaning
// change would "tidy", and tidying it would make the engine an author.
//
// Run:  npm run entities

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { env } from '../config.js';

const PAGE_SIZE = 200;

export async function run(db = pool) {
  if (!env.jubileepediaApiUrl) {
    return {
      skipped: 'JUBILEEPEDIA_API_URL is not configured',
      note: 'Entity panels render from the `entities` table; without this job nothing fills it, '
          + 'so the entity intent never fires.',
    };
  }

  const started = Date.now();
  let cursor = null;
  let pages = 0;
  let seen = 0;
  let written = 0;
  const keys = [];

  do {
    const batch = await fetchBatch(cursor);
    if (!batch) break;
    pages++;

    const entities = (batch.entities ?? batch.data ?? []).filter(usable);
    seen += entities.length;

    if (entities.length > 0) {
      written += await upsert(db, entities);
      keys.push(...entities.map((e) => e.entity_key ?? e.key));
    }

    cursor = batch.next_cursor ?? batch.next ?? null;
  } while (cursor && pages < 200);

  // Anything JubileePedia no longer publishes is deactivated rather than
  // deleted: an entity that briefly vanishes from an API response should not
  // take its aliases and its concept link with it, and `active` is what the
  // panel lookup already filters on.
  let deactivated = 0;
  if (keys.length > 0) {
    const { rowCount } = await db.query(
      `UPDATE entities SET active = FALSE
        WHERE active AND NOT (entity_key = ANY($1::text[]))`, [keys]);
    deactivated = rowCount;
  }

  return {
    pages, seen, written, deactivated,
    took_ms: Date.now() - started,
  };
}

/**
 * An entity with no key, no name or no source URL cannot be rendered: §7.8
 * makes `source_url` NOT NULL because the panel has to credit JubileePedia and
 * link back to it. Dropping the row is better than inventing a citation.
 */
function usable(entity) {
  const key = entity?.entity_key ?? entity?.key;
  return Boolean(key && (entity.display_name ?? entity.name) && (entity.source_url ?? entity.url));
}

async function fetchBatch(cursor) {
  const url = new URL(`${env.jubileepediaApiUrl.replace(/\/$/, '')}/v1/entities`);
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (cursor) url.searchParams.set('cursor', cursor);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`JubileePedia returned ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'job.entities', msg: err.message }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function upsert(db, entities) {
  const { rows } = await db.query(
    `INSERT INTO entities
        (entity_key, entity_type, display_name, summary, source_url, facts,
         related_urls, concept_id, active, synced_at)
     SELECT u.key, u.type, u.name, u.summary, u.source_url,
            u.facts::jsonb, u.related::jsonb,
            -- R10 links an entity to its lexicon concept so the two agree about
            -- what a word means. A concept key JubileePedia names but the
            -- lexicon does not have yet resolves to NULL rather than failing the
            -- row -- D9 has not landed, so that is the common case today.
            (SELECT c.id FROM lexicon_concepts c WHERE c.concept_key = u.concept_key),
            TRUE, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                   $6::text[], $7::text[], $8::text[])
            AS u(key, type, name, summary, source_url, facts, related, concept_key)
     ON CONFLICT (entity_key) DO UPDATE SET
        entity_type  = EXCLUDED.entity_type,
        display_name = EXCLUDED.display_name,
        summary      = EXCLUDED.summary,
        source_url   = EXCLUDED.source_url,
        facts        = EXCLUDED.facts,
        related_urls = EXCLUDED.related_urls,
        concept_id   = EXCLUDED.concept_id,
        active       = TRUE,
        synced_at    = now()
     RETURNING id, entity_key`,
    [entities.map((e) => e.entity_key ?? e.key),
     entities.map((e) => e.entity_type ?? e.type ?? 'concept'),
     entities.map((e) => e.display_name ?? e.name),
     entities.map((e) => e.summary ?? null),
     entities.map((e) => e.source_url ?? e.url),
     entities.map((e) => JSON.stringify(e.facts ?? [])),
     entities.map((e) => JSON.stringify(e.related_urls ?? e.related ?? [])),
     entities.map((e) => e.concept_key ?? null)]);

  const byKey = new Map(rows.map((r) => [r.entity_key, Number(r.id)]));
  await syncAliases(db, entities, byKey);
  return rows.length;
}

// A byte that cannot appear in an alias, so the Map key is unambiguous.
const SEP = String.fromCharCode(31);

/**
 * Aliases are what the intent router matches on, so they are replaced rather
 * than merged: an alias JubileePedia removed should stop routing to the panel.
 *
 * The display name is always an alias of itself. Without that, an entity called
 * "Shavuot" whose alias list happens not to repeat "shavuot" would never match
 * a search for its own name.
 */
async function syncAliases(db, entities, byKey) {
  for (const entity of entities) {
    const id = byKey.get(entity.entity_key ?? entity.key);
    if (!id) continue;

    // Keyed on a Map, not on a delimited string. Aliases here are routinely
    // multi-word -- "ruach hakodesh", "day of atonement" -- so packing the
    // alias and its language into one string and splitting it back apart
    // would shred every alias containing a space, which is most of the ones
    // that matter on this corpus.
    const names = new Map();
    const add = (value, lang) => {
      const alias = String(value ?? '').toLowerCase().trim();
      const language = lang ?? 'en';
      if (alias) names.set(language + SEP + alias, { alias, lang: language });
    };

    add(entity.display_name ?? entity.name, 'en');
    for (const alias of entity.aliases ?? []) {
      if (typeof alias === 'string') add(alias, 'en');
      else add(alias.alias ?? alias.name, alias.lang);
    }

    const pairs = [...names.values()];

    await db.query('DELETE FROM entity_aliases WHERE entity_id = $1', [id]);
    if (pairs.length === 0) continue;

    await db.query(
      `INSERT INTO entity_aliases (entity_id, alias, lang)
       SELECT $1, u.alias, u.lang
         FROM unnest($2::text[], $3::text[]) AS u(alias, lang)
       ON CONFLICT DO NOTHING`,
      [id, pairs.map((p) => p.alias), pairs.map((p) => p.lang)]);
  }
}

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run();
  console.log(JSON.stringify({ level: 'info', at: 'job.entities', ...result }, null, 2));
  await pool.end();
}
