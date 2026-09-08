#!/usr/bin/env node
// Bring a development database up to something you can actually search.
//
// Three steps, each of which is the real code path rather than a fixture:
//
//   1. Verify the seeded T1 domains, which is what grants Zone A eligibility
//      (§8.2). Nothing appears in Zone A until this has been done.
//   2. Build a content root out of `setup/initial_setup.md`, one file per
//      section, with frontmatter. This is derived from a document that is
//      really in the repository -- no invented articles -- and it happens to
//      contain "Ruach HaKodesh" alongside "Holy Spirit", and "teshuvah"
//      alongside "repentance", which is exactly what acceptance criterion 8
//      tests for.
//   3. Run the real source-markdown ingest (R5, §9.1) over it.
//
// Run:  npm run dev:seed
//
// It refuses to run against anything but PGlite. Registering a fake domain and
// pointing it at a generated content root is not something to do to a real
// index by accident.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.env.USE_PGLITE !== '1') {
  console.error(
`dev-seed is for the PGlite development database only.

  USE_PGLITE=1 PGLITE_DIR=.pglite-dev npm run dev:seed

Against a real index this would register a domain that does not exist and
ingest generated content into it.`);
  process.exit(1);
}

const { pool } = await import('../src/db.js');
const { run: runIngest } = await import('../src/jobs/ingest.js');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const contentRoot = join(here, '..', '.dev-content');
const HOST = 'jubileeverse.com';

// --- 1. verification (§8.2) --------------------------------------------------
const { rows: verified } = await pool.query(
  `UPDATE domains
      SET zone_a_eligible = TRUE, status = 'active',
          verification_method = 'authoritative_list', verified_at = now(),
          approved_by = 'dev-seed', approved_at = now()
    WHERE tier = 'T1'
    RETURNING host`);
console.log(`Verified ${verified.length} T1 domains as Zone A eligible.`);

// --- 2. content root ---------------------------------------------------------
const spec = await readFile(join(repoRoot, 'setup', 'initial_setup.md'), 'utf8');

// Split on level-2 headings. Each section becomes a page, which is roughly how
// the network's own long-form content is shaped: a title, a few headings, and
// several hundred words under each.
const sections = [];
let current = null;
for (const line of spec.split('\n')) {
  const heading = /^##\s+(?!#)(.+?)\s*$/.exec(line);
  if (heading) {
    if (current) sections.push(current);
    current = { title: heading[1].replace(/^\d+\.\s*/, '').trim(), lines: [] };
    continue;
  }
  if (current) current.lines.push(line);
}
if (current) sections.push(current);

await rm(contentRoot, { recursive: true, force: true });
await mkdir(join(contentRoot, 'articles'), { recursive: true });

const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

let written = 0;
const paths = [];
for (const section of sections) {
  const body = section.lines.join('\n').trim();
  if (body.split(/\s+/).filter(Boolean).length < 60) continue;   // skip stubs

  const slug = slugify(section.title);
  if (!slug) continue;

  const path = `articles/${slug}.md`;
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(section.title)}`,
    `slug: ${slug}`,
    'category: Engineering Notes',
    'persona: Gabriel Ungureanu',
    'office: Teacher',
    'language: en',
    'created: 2026-09-03',
    'tags: [specification, search, engineering]',
    '---',
    '',
    `# ${section.title}`,
    '',
    body,
    '',
  ].join('\n');

  await writeFile(join(contentRoot, path), frontmatter, 'utf8');
  paths.push(path);
  written++;
}

// A remote source_root needs a manifest because HTTP has no directory listing
// (see src/ingest/source.js). A filesystem root is walked, so this is only here
// to keep the two shapes exercised by the same fixture.
await writeFile(join(contentRoot, 'search-manifest.json'),
  JSON.stringify({ paths }, null, 2), 'utf8');

console.log(`Wrote ${written} pages to ${contentRoot} (derived from setup/initial_setup.md).`);

// --- 3. point a domain at it and ingest (R5, §9.1) ---------------------------
await pool.query(
  `UPDATE domains
      SET source_root = $2,
          url_template = 'https://{host}/{category_slug}/{slug}',
          ingest_mode = 'source_md',
          status = 'active'
    WHERE host = $1`,
  [HOST, contentRoot]);

console.log(`\nIngesting ${HOST} from source markdown...\n`);
const result = await runIngest(pool, { host: HOST });
console.log(JSON.stringify(result, null, 2));

// Structural quality is normally recomputed nightly; without it every page
// scores null and the Zone A quality boost is inert.
const { recomputeQuality } = await import('../src/jobs/engagement.js');
console.log(JSON.stringify(await recomputeQuality(pool)));

const { rows: summary } = await pool.query(`
  SELECT (SELECT count(*) FROM pages WHERE status = 'indexed') AS indexed,
         (SELECT count(*) FROM chunks) AS chunks,
         (SELECT count(*) FROM zone_a_pages) AS zone_a_servable`);
console.log('\n', JSON.stringify(summary[0]));

console.log(`
Ready. Start the API and the site:

  USE_PGLITE=1 PGLITE_DIR=.pglite-dev npm start     # API on :4038
  npm run site                                      # site on :8080

Then try http://localhost:8080/search?q=holy+spirit
`);

await pool.end();
