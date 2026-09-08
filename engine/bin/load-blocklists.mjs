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
// Run:  npm run blocklists -- [--source=<name>] [--dry-run]

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';
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
    const body = await download(source.url);
    const entries = parse(body, source);

    if (entries.length === 0) {
      // An empty list is nearly always a dead feed answering with a redirect or
      // an error page, not a category that suddenly has no members. Refusing to
      // load it is what stops a silent unblocking of an entire category.
      await finishLoad(loadId, { parsed: 0, written: 0, outcome: 'empty' });
      console.log(`SKIPPED - parsed 0 entries (dead feed? check ${source.url})`);
      report.push({ source: source.name, loaded: 0, skipped: 'empty' });
      continue;
    }

    if (flags['dry-run']) {
      await finishLoad(loadId, { parsed: entries.length, written: 0, outcome: 'dry_run' });
      console.log(`${entries.length} entries (not written)`);
      report.push({ source: source.name, parsed: entries.length, written: 0 });
      total += entries.length;
      continue;
    }

    const written = await store(source, entries);
    await finishLoad(loadId, { parsed: entries.length, written, outcome: 'ok' });
    console.log(`${written} entries`);
    report.push({ source: source.name, parsed: entries.length, written });
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

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parse(body, source) {
  const out = [];
  const seen = new Set();

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    let host = null;
    let matchType = 'host';

    switch (source.format) {
      case 'hosts': {
        // "0.0.0.0 example.com" or "127.0.0.1 example.com"
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        host = parts[1];
        // The sinkhole entries for localhost itself are not blocklist content.
        if (['localhost', 'localhost.localdomain', 'broadcasthost', 'ip6-localhost'].includes(host)) continue;
        break;
      }
      case 'domains':
        host = line.split(/\s+/)[0];
        break;
      case 'urls': {
        try {
          const url = new URL(line.includes('://') ? line : `http://${line}`);
          host = url.hostname;
          // A URL list is usually blocking a section of an otherwise fine site,
          // so blocking the whole host would be too broad.
          if (url.pathname && url.pathname !== '/') {
            out.push({
              pattern: `^https?://(www\\.)?${escapeRegex(url.hostname)}${escapeRegex(url.pathname)}`,
              matchType: 'regex',
            });
            continue;
          }
        } catch { continue; }
        break;
      }
      default:
        throw new Error(`unknown format '${source.format}'`);
    }

    if (!host) continue;
    host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);

    out.push({ pattern: host, matchType });
  }

  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace this source's rows, in one transaction.
 *
 * Replace rather than merge: a host that a list has dropped should stop being
 * blocked by that list. Merging would make every load permanent and the
 * blocklist would only ever grow, which over a few years turns into a long tail
 * of sites blocked for reasons nobody can reconstruct.
 *
 * The `source` column is what scopes the delete, so a category can also be
 * disabled with a single UPDATE, exactly as the v0 engine's README described.
 */
async function store(source, entries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM blocklist_entries WHERE source = $1', [source.name]);

    const CHUNK = 5000;
    let written = 0;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      const { rowCount } = await client.query(
        `INSERT INTO blocklist_entries (pattern, match_type, category, source, severity)
         SELECT u.pattern, u.match_type, $3, $4, $5
           FROM unnest($1::text[], $2::text[]) AS u(pattern, match_type)
         ON CONFLICT DO NOTHING`,
        [slice.map((e) => e.pattern), slice.map((e) => e.matchType),
         source.category, source.name, source.severity ?? 100]);
      written += rowCount;
    }

    await client.query('COMMIT');
    return written;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
