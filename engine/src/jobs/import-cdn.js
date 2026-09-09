// JubileeVerse CDN importer.
//
//   node src/jobs/import-cdn.js --domain=jubileeverse.com
//   node src/jobs/import-cdn.js --domain=jubileeverse.com --dry-run
//   node src/jobs/import-cdn.js --domain=jubileeverse.com --folder=teshuvah-restoration
//   node src/jobs/import-cdn.js --domain=jubileeverse.com --force
//
// Discovery is the five category manifests and nothing else (src/ingest/cdn.js).
// Content is markdown with YAML frontmatter, which R5 (§9.1) already parses --
// `mapToPage` from src/ingest/markdown.js does the parsing here too, so there is
// one frontmatter reader in the codebase rather than two that drift.
//
// Three levels of "has this changed?", cheapest first, because a full sync is
// 5 manifests + 600 articles and almost none of it changes between runs:
//
//   1. manifest ETag      -- a 304 skips an entire category
//   2. article ETag       -- a 304 skips the download
//   3. content hash       -- a downloaded-but-identical body skips re-chunking
//                            and therefore re-embedding, which is the expensive
//                            part (upsertPage owns this check)
//
// Only the third can be reached without a download, and only the third protects
// against a publisher that rewrites files without changing them.

import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { upsertPage } from '../ingest/service.js';
import { mapToPage, urlHash } from '../ingest/markdown.js';
import {
  CDN_FOLDERS, fetchManifest, fetchArticleMarkdown,
  routeForFolder, publicUrl, makeArticleId, ARTICLES_ROOT,
} from '../ingest/cdn.js';

/** Validators are kept per page; the manifest's live on a synthetic row. */
const manifestKey = (folder) => `cdn-manifest:${folder}`;

async function loadDomain(db, host) {
  const { rows } = await db.query(
    `SELECT id, host, tier, status, ingest_mode, language_hint, zone_a_eligible
       FROM domains WHERE host = $1`, [host]);
  return rows[0] ?? null;
}

/** Everything this domain currently has from the CDN, by article id. */
async function existingPages(db, domainId) {
  const { rows } = await db.query(
    `SELECT source_path, url, status, etag, last_modified_http
       FROM pages
      WHERE domain_id = $1 AND source_path LIKE 'cdn:%'`, [domainId]);
  return new Map(rows.map((r) => [r.source_path.slice(4), r]));
}

async function readValidator(db, domainId, key) {
  const { rows } = await db.query(
    `SELECT etag, last_modified_http FROM pages WHERE domain_id = $1 AND source_path = $2`,
    [domainId, key]);
  return rows[0] ?? {};
}

async function writeValidator(db, domainId, key, url, etag, lastModified) {
  // A manifest is not a page and must never be servable, so it is parked at
  // status 'discovered' -- outside the servable_pages gate, which requires
  // 'indexed'. It exists only to carry an ETag between runs.
  await db.query(
    `INSERT INTO pages (domain_id, url, url_hash, source_path, status, tier,
                        title, etag, last_modified_http, last_fetched_at)
     VALUES ($1,$2,$7,$3,'discovered',
             (SELECT tier FROM domains WHERE id=$1), $4, $5, $6::timestamptz, now())
     ON CONFLICT (domain_id, url_hash) DO UPDATE
        SET etag = EXCLUDED.etag,
            last_modified_http = EXCLUDED.last_modified_http,
            last_fetched_at = now()`,
    [domainId, url, key, `manifest ${key}`, etag, lastModified, urlHash(url)]);
}

export async function run({
  host, db = pool, dryRun = false, force = false, folders = CDN_FOLDERS, onProgress = null,
} = {}) {
  const domain = await loadDomain(db, host);
  if (!domain) throw new Error(`no domain registered for ${host}`);
  if (domain.status !== 'active') {
    throw new Error(`${host} is ${domain.status}; §8.2 reserves Zone A for a verified, active domain`);
  }

  const started = new Date();
  const known = await existingPages(db, domain.id);
  const seenIds = new Set();

  const stats = {
    manifests_processed: 0, manifests_unchanged: 0,
    discovered: 0, published: 0,
    imported: 0, updated: 0, unchanged: 0,
    not_modified_304: 0, skipped_unpublished: 0,
    rejected: 0, failed: 0, unpublished: 0,
  };
  const problems = [];

  for (const folder of folders) {
    const mKey = manifestKey(folder);
    const mPrev = force ? {} : await readValidator(db, domain.id, mKey);

    let manifest;
    try {
      manifest = await fetchManifest(folder, {
        etag: mPrev.etag,
        lastModified: mPrev.last_modified_http
          ? new Date(mPrev.last_modified_http).toUTCString() : null,
      });
    } catch (err) {
      stats.failed += 1;
      problems.push({ folder, error: err.message });
      continue;
    }

    stats.manifests_processed += 1;

    if (manifest.status === 304) {
      stats.manifests_unchanged += 1;
      // The category is unchanged, but its articles must still be counted as
      // "seen" or the withdrawal pass below would unpublish every one of them.
      for (const [id, row] of known) {
        if (row.source_path?.startsWith('cdn:') || true) {
          if (id.startsWith(`${routeForFolder(folder)}__`)) seenIds.add(id);
        }
      }
      onProgress?.({ folder, status: 'manifest unchanged (304)' });
      continue;
    }

    stats.discovered += manifest.listedTotal;
    stats.published += manifest.articles.length;
    stats.skipped_unpublished += manifest.listedTotal - manifest.articles.length;

    // The ROUTE slug, from the folder map -- deliberately NOT the manifest's own
    // `category_slug`.
    //
    // For four categories they agree. For the fifth they do not: the bundle
    // publishes `"category_slug": "torah-hebraic"` while the site's nav links to
    // `torah-hebraic-insights` (CATEGORY_ROUTES in the site's articles.ts).
    // Both forms resolve, because `folderForRoute` passes an unmapped slug
    // through -- so taking the manifest's value produces a working but
    // non-canonical URL, and the index would hold a second address for an
    // article the nav links to under the first. One page, one URL.
    const routeSlug = routeForFolder(folder);

    for (const entry of manifest.articles) {
      const id = makeArticleId(routeSlug, entry.slug);
      seenIds.add(id);
      const prior = known.get(id);

      let fetched;
      try {
        fetched = await fetchArticleMarkdown(folder, entry.file, {
          etag: force ? null : prior?.etag,
          lastModified: force || !prior?.last_modified_http
            ? null : new Date(prior.last_modified_http).toUTCString(),
        });
      } catch (err) {
        stats.failed += 1;
        if (problems.length < 25) problems.push({ id, error: err.message });
        continue;
      }

      if (fetched.status === 304) { stats.not_modified_304 += 1; continue; }
      if (fetched.status === 404) {
        stats.failed += 1;
        if (problems.length < 25) problems.push({ id, error: 'listed in the manifest but 404 on the CDN' });
        continue;
      }

      if (dryRun) continue;

      // The site's own parser, not a second one.
      const mapped = mapToPage(fetched.body, domain, `cdn:${id}`);

      // Identity and destination are decided here rather than by a URL template:
      // the public reader route is /article/<categorySlug>__<slug>, and the
      // category half is the ROUTE slug, which differs from the folder for
      // torah-hebraic.
      mapped.url = publicUrl(domain.host, routeSlug, entry.slug);
      mapped.source_path = `cdn:${id}`;
      // The bundles carry no language field anywhere -- manifest or frontmatter
      // -- so the domain's hint decides rather than a guess per article.
      mapped.language = mapped.language ?? domain.language_hint ?? 'en';
      mapped.category = mapped.category ?? manifest.category;
      mapped.office = mapped.office ?? manifest.office ?? entry.office ?? null;
      mapped.author = mapped.author ?? entry.author ?? null;

      try {
        // priority 1: §12.2's publish-push lane. An import from the published
        // bundle is a publish.
        const result = await upsertPage(domain, mapped, fetched.body, { priority: 1 });
        if (result.status === 'created') stats.imported += 1;
        else if (result.status === 'updated') stats.updated += 1;
        else if (result.status === 'unchanged') stats.unchanged += 1;
        else if (result.status === 'rejected') {
          stats.rejected += 1;
          if (problems.length < 25) problems.push({ id, error: result.reason });
        }

        if (result.page_id) {
          await db.query(
            `UPDATE pages SET etag = $2, last_modified_http = $3::timestamptz WHERE id = $1`,
            [result.page_id, fetched.etag, fetched.lastModified]);
        }
      } catch (err) {
        stats.failed += 1;
        if (problems.length < 25) problems.push({ id, error: err.message });
      }
    }

    if (!dryRun) {
      await writeValidator(db, domain.id, mKey, manifestUrlFor(folder),
        manifest.etag, manifest.lastModified);
    }
    onProgress?.({ folder, published: manifest.articles.length });
  }

  // --- withdrawal -----------------------------------------------------------
  // Anything previously indexed that no manifest lists any more. Marked, never
  // deleted: `servable_pages` requires status='indexed', so this alone removes
  // it from every result while keeping the row, its chunks and its click
  // history. Re-publishing later is a status change, not a re-import.
  //
  // Only ever runs over the folders actually walked -- a --folder run must not
  // unpublish the other four categories.
  if (!dryRun && folders.length === CDN_FOLDERS.length) {
    const routeSlugs = folders.map(routeForFolder);
    const { rows } = await db.query(
      `SELECT id, source_path FROM pages
        WHERE domain_id = $1 AND source_path LIKE 'cdn:%' AND status = 'indexed'`,
      [domain.id]);
    for (const row of rows) {
      const id = row.source_path.slice(4);
      if (seenIds.has(id)) continue;
      if (!routeSlugs.some((r) => id.startsWith(`${r}__`))) continue;
      await db.query(`UPDATE pages SET status = 'unpublished' WHERE id = $1`, [row.id]);
      stats.unpublished += 1;
    }
  }

  if (!dryRun) {
    await db.query(
      `INSERT INTO ingest_runs (domain_id, mode, started_at, finished_at,
                                items_seen, items_written, pages_seen, pages_changed, pages_failed)
       VALUES ($1,'cdn',$2,now(),$3,$4,$3,$4,$5)`,
      [domain.id, started, stats.published,
       stats.imported + stats.updated, stats.failed]);
  }

  return { host, source: ARTICLES_ROOT, dry_run: dryRun, force, ...stats, problems };
}

const manifestUrlFor = (folder) => `${ARTICLES_ROOT}/${folder}/articles.json`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const has = (n) => process.argv.includes(`--${n}`);
  const host = arg('domain') ?? 'jubileeverse.com';
  const one = arg('folder');

  try {
    const result = await run({
      host,
      dryRun: has('dry-run'),
      force: has('force'),
      folders: one ? [one] : CDN_FOLDERS,
      onProgress: (p) => console.error(`  ${p.folder}: ${p.status ?? `${p.published} published`}`),
    });
    console.log(JSON.stringify({ level: 'info', at: 'job.import-cdn', ...result }, null, 1));
    await pool.end();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', at: 'job.import-cdn', msg: err.message }));
    await pool.end();
    process.exit(1);
  }
}
