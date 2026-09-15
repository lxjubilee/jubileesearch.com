#!/usr/bin/env node
// Blocklist loader (§11.1 gate 1).
//
// "Sources to load and refresh: the University of Toulouse (UT1) categorized
// blocklists... the StevenBlack consolidated hosts project, including its adult
// and gambling variants... a manual Jubilee blocklist maintained in the admin
// console."
//
// And the warning that shapes this file: "Verification required: confirm current
// availability, license terms, and update cadence for each list before the
// build. Some historically popular lists, including Shallalist, are no longer
// maintained. Do not architect around a dead feed. Whatever sources are chosen,
// the loader must be source-agnostic and refresh on a schedule."
//
// So sources are configuration, not code. They live in `blocklist-sources.json`
// beside this file, each declaring its format, and adding or retiring one is an
// edit to that file. Nothing here knows the name of any particular list.
//
// Formats understood:
//   hosts    the /etc/hosts format StevenBlack publishes -- "0.0.0.0 example.com"
//   domains  one host per line, which is what UT1's category archives contain
//   urls     one full URL per line, stored as a regex match on the path
//
// Archives: a source with `"archive": "tar.gz"` is unpacked in flight and the
// member named by `"member"` (default "domains") is read. UT1 publishes
// `adult.tar.gz` containing `adult/domains`, and that file is 4.6 million
// lines, so nothing here holds a list in memory: bytes stream from the fetch
// through gunzip and the tar reader into 5,000-row inserts. The unique index
// from migration 042 does the de-duplication that used to happen in a Set.
//
// Run:  npm run blocklists -- [--source=<name>] [--dry-run]

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pool } from '../src/db.js';
import { splitLines, tarMember, parseLine } from '../src/safety/list-stream.js';
import { USER_AGENT } from '../src/crawl/fetcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));

const config = JSON.parse(await readFile(join(here, 'blocklist-sources.json'), 'utf8'));

const sources = config.sources.filter((s) =>
  s.enabled !== false && (!flags.source || s.name === flags.source));

if (sources.length === 0) {
  console.error(flags.source
    ? `No enabled source named '${flags.source}'.`
    : 'No sources are enabled in blocklist-sources.json.');
  process.exit(1);
}

console.log(`Loading ${sources.length} source(s)${flags['dry-run'] ? ' (dry run)' : ''}\n`);

let total = 0;
const report = [];

for (const source of sources) {
  process.stdout.write(`  ${source.name.padEnd(28)} `);

  // Screen 7 shows load history, not just the current rows. Without it a source
  // that started returning an empty file looks identical to one never loaded.
  const { rows: loadRow } = await pool.query(
    `INSERT INTO blocklist_loads (source, url, outcome) VALUES ($1, $2, 'running') RETURNING id`,
    [source.name, source.url]);
  const loadId = loadRow[0].id;

  try {
    const { parsed, written } = await load(source, { dryRun: Boolean(flags['dry-run']) });

    if (parsed === 0) {
      // An empty list is nearly always a dead feed answering with a redirect or
      // an error page, not a category that suddenly has no members. Refusing to
      // load it is what stops a silent unblocking of an entire category.
      await finishLoad(loadId, { parsed: 0, written: 0, outcome: 'empty' });
      console.log(`SKIPPED - parsed 0 entries (dead feed? check ${source.url})`);
      report.push({ source: source.name, loaded: 0, skipped: 'empty' });
      continue;
    }

    if (flags['dry-run']) {
      await finishLoad(loadId, { parsed, written: 0, outcome: 'dry_run' });
      console.log(`${parsed} entries (not written)`);
      report.push({ source: source.name, parsed, written: 0 });
      total += parsed;
      continue;
    }

    await finishLoad(loadId, { parsed, written, outcome: 'ok' });
    console.log(`${written} entries (${parsed} parsed)`);
    report.push({ source: source.name, parsed, written });
    total += written;
  } catch (err) {
    await finishLoad(loadId, { outcome: 'failed', error: err.message });
    console.log(`FAILED - ${err.message}`);
    report.push({ source: source.name, error: err.message });
  }
}

console.log(`\n${total} entries across ${report.filter((r) => !r.error).length} source(s).`);

if (!flags['dry-run']) {
  const { rows } = await pool.query(
    `SELECT source, count(*) AS n FROM blocklist_entries GROUP BY source ORDER BY source`);
  console.log('\nblocklist_entries now holds:');
  for (const row of rows) console.log(`  ${String(row.source).padEnd(28)} ${row.n}`);

  console.log(
`\nManual entries and the scripture allow-list from migration 024 are never
touched by this loader: it only replaces rows whose source matches the one it
just loaded.`);
}

await pool.end();

// ---------------------------------------------------------------------------

async function finishLoad(id, { parsed = null, written = null, outcome, error = null }) {
  await pool.query(
    `UPDATE blocklist_loads
        SET finished_at = now(), entries_parsed = $2, entries_written = $3,
            outcome = $4, error = $5
      WHERE id = $1`,
    [id, parsed, written, outcome, error ? String(error).slice(0, 500) : null]);
}

/**
 * Stream one source into the table.
 *
 * Replace rather than merge: a host that a list has dropped should stop being
 * blocked by that list. Merging would make every load permanent and the
 * blocklist would only ever grow, which over a few years turns into a long tail
 * of sites blocked for reasons nobody can reconstruct. The delete and the
 * inserts share one transaction, so a download that dies halfway leaves the
 * previous load in place rather than an empty category.
 */
async function load(source, { dryRun }) {
  const CHUNK = 5000;
  let parsed = 0;
  let written = 0;
  let batch = [];

  const client = dryRun ? null : await pool.connect();
  const flush = async () => {
    if (batch.length === 0 || dryRun) { batch = []; return; }
    const { rowCount } = await client.query(
      `INSERT INTO blocklist_entries (pattern, match_type, category, source, severity)
       SELECT u.pattern, u.match_type, $3, $4, $5
         FROM unnest($1::text[], $2::text[]) AS u(pattern, match_type)
       ON CONFLICT DO NOTHING`,
      [batch.map((e) => e.pattern), batch.map((e) => e.matchType),
       source.category, source.name, source.severity ?? 100]);
    written += rowCount;
    batch = [];
  };

  try {
    if (client) {
      await client.query('BEGIN');
      await client.query('DELETE FROM blocklist_entries WHERE source = $1', [source.name]);
    }
    for await (const line of lines(source)) {
      const entry = parseLine(line, source);
      if (!entry) continue;
      parsed++;
      batch.push(entry);
      if (batch.length >= CHUNK) await flush();
    }
    await flush();
    if (client) {
      if (parsed === 0) await client.query('ROLLBACK'); // keep the previous load
      else await client.query('COMMIT');
    }
    return { parsed, written };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

/** The lines of the list, whether it arrives as text or inside a tar.gz. */
async function* lines(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  try {
    const res = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let stream = Readable.fromWeb(res.body);
    if (source.archive === 'tar.gz') {
      stream = tarMember(stream.pipe(createGunzip()), source.member ?? 'domains');
    }
    yield* splitLines(stream);
  } finally {
    clearTimeout(timer);
  }
}

// splitLines, tarMember and parseLine live in src/safety/list-stream.js so
// they can be tested without a network.
