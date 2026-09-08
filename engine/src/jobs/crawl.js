// Crawl worker: the loop that joins the frontier, the fetcher, the extractor,
// the safety gates and the index.
//
// Serves three jobs that the specification describes separately but which are
// the same pipeline with a different tier attached:
//
//   * T1 reconciliation and the source-markdown fallback (§9.1: "any T1 domain
//     without accessible source markdown runs ingest_mode = 'crawl'"). With
//     decision D5 open, this is currently the only way anything reaches the
//     index at all.
//   * T2 whitelist recrawl, weekly (§8.3).
//   * T3 open-web, monthly, behind the full safety pipeline (§11).
//
// Run it as:  npm run crawl -- [--host=example.com] [--tier=T2] [--seed] [--max=500]

import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { pool } from '../db.js';
import { ranking } from '../config.js';
import {
  dueDomains, seedDomain, claimBatch, completeItem, deferItem,
  reclaimStale, enqueue, finishRun,
} from '../crawl/frontier.js';
import { fetchPage, backoffMs } from '../crawl/fetcher.js';
import { extract } from '../crawl/extractor.js';
import { extractPdfText } from '../crawl/pdf.js';
import { parseXRobotsTag } from '../crawl/robots.js';
import { upsertCrawledPage, resolveNearDuplicates, markGoneByUrl, recordFailure } from '../crawl/store.js';
import { loadRules, evaluate, VERDICTS } from '../safety/gates.js';
import { urlHash, normalizeUrl } from '../ingest/markdown.js';

const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}:${process.pid}`;

/**
 * Process one queue item end to end.
 * Exported so a single URL can be re-run from the admin console for diagnosis.
 */
export async function processItem(db, item, context) {
  const { domains, rules, cfg } = context;
  const domain = domains.get(Number(item.domain_id));
  if (!domain) {
    await completeItem(db, item.id);
    return { outcome: 'skipped', reason: 'domain no longer registered' };
  }

  // Validators from the previous fetch, so the request can come back 304.
  const { rows: known } = await db.query(
    `SELECT etag, last_modified_http FROM pages WHERE domain_id = $1 AND url_hash = $2`,
    [domain.id, urlHash(normalizeUrl(item.url))]);

  const fetched = await fetchPage(item.url, domain, known[0] ?? {});

  switch (fetched.outcome) {
    case 'not_modified':
      await db.query(
        `UPDATE pages SET last_fetched_at = now(), fetch_failures = 0
          WHERE domain_id = $1 AND url_hash = $2`,
        [domain.id, urlHash(normalizeUrl(item.url))]);
      await completeItem(db, item.id);
      return { outcome: 'not_modified' };

    case 'gone':
      await markGoneByUrl(db, domain.id, item.url);
      await recordFailure(db, domain.id, item.url, fetched);
      await completeItem(db, item.id);
      return { outcome: 'gone' };

    case 'robots_denied':
    case 'skipped':
      await recordFailure(db, domain.id, item.url, fetched);
      if (fetched.retryable) {
        // robots.txt was unreachable rather than forbidding. Try again later
        // rather than treating a bad minute as a permanent refusal.
        await deferItem(db, item.id, backoffMs(item.attempts), fetched.reason);
      } else {
        await completeItem(db, item.id);
      }
      return { outcome: fetched.outcome, reason: fetched.reason };

    case 'error':
      await recordFailure(db, domain.id, item.url, fetched);
      if (fetched.retryable && item.attempts < 5) {
        await deferItem(db, item.id, backoffMs(item.attempts, fetched.retryAfterMs), fetched.reason);
      } else {
        await completeItem(db, item.id);
      }
      return { outcome: 'error', reason: fetched.reason };

    default:
      break;
  }

  // --- extraction -----------------------------------------------------------
  let extracted;

  if (fetched.content_type === 'application/pdf') {
    const pdf = extractPdfText(fetched.body);
    if (!pdf.ok) {
      // §9.5: "Scanned PDFs with no text layer are marked rejected with reason
      // no_text_layer."
      await db.query(
        `UPDATE pages SET status = 'rejected',
                          safety_reasons = jsonb_build_object('rejected', $3::text)
          WHERE domain_id = $1 AND url_hash = $2`,
        [domain.id, urlHash(normalizeUrl(item.url)), pdf.reason]);
      await recordFailure(db, domain.id, item.url, { outcome: 'skipped', reason: pdf.reason });
      await completeItem(db, item.id);
      return { outcome: 'rejected', reason: pdf.reason };
    }
    extracted = pdfToExtracted(pdf, fetched);
  } else if (fetched.content_type === 'text/plain') {
    extracted = plainTextToExtracted(fetched);
  } else {
    extracted = extract(fetched.body, fetched.final_url ?? item.url, {
      headers: { 'x-robots-tag': fetched.x_robots_tag },
    });
  }

  // X-Robots-Tag can address a named bot; the extractor only saw the header
  // value, so the scoped form is resolved here.
  const headerRobots = parseXRobotsTag(fetched.x_robots_tag);
  const noindex = extracted.robots?.noindex || headerRobots.noindex;
  const nofollow = extracted.robots?.nofollow || headerRobots.nofollow;

  // Links are queued even for a noindex page. noindex and nofollow are separate
  // directives and conflating them is the usual bug: a hub page that says
  // noindex is often exactly the page whose links are worth having.
  let queued = 0;
  if (!nofollow && item.depth < (domain.max_depth ?? 5)) {
    const followable = (extracted.links ?? [])
      .filter((l) => l.is_internal && !l.nofollow)
      .map((l) => l.to_url);
    if (followable.length) {
      const result = await enqueue(db, followable, domain, {
        depth: item.depth + 1,
        source: 'crawl',
        discoveredFrom: null,
      });
      queued = result.queued;
    }
  }

  if (noindex) {
    await recordFailure(db, domain.id, item.url, { outcome: 'skipped', reason: 'noindex directive' });
    await completeItem(db, item.id);
    return { outcome: 'noindex', queued };
  }

  if (!extracted.body_text || extracted.word_count < 25) {
    await recordFailure(db, domain.id, item.url, { outcome: 'skipped', reason: 'thin_content' });
    await completeItem(db, item.id);
    return { outcome: 'rejected', reason: 'thin_content', queued };
  }

  // --- safety (§11) ---------------------------------------------------------
  // T1 skips every gate; T2 runs 1, 2 and 4; T3 runs all of them. `evaluate`
  // holds that logic, and an unexpected failure inside it returns 'unsafe'
  // rather than throwing, so P1 holds on the error path too.
  const verdict = await evaluate({
    tier: domain.tier,
    host: domain.host,
    url: fetched.final_url ?? item.url,
    title: extracted.title,
    description: extracted.description,
    bodyText: extracted.body_text,
  }, rules, cfg);

  const written = await upsertCrawledPage(domain, { ...fetched, url: item.url }, extracted, verdict, cfg);

  // A quarantined or rejected page still needs its review row and its domain
  // strike, which is what applyVerdict does -- but it has already been written
  // with the right status, so only the side effects are needed.
  if (verdict.verdict === VERDICTS.REVIEW || verdict.verdict === VERDICTS.UNCLASSIFIED) {
    await db.query(
      `INSERT INTO safety_reviews (page_id, machine_score, machine_reasons)
       VALUES ($1, $2, $3::jsonb)`,
      [written.page_id, verdict.score, JSON.stringify(verdict.reasons ?? [])]);
  }
  if (verdict.verdict === VERDICTS.UNSAFE) {
    await strikeDomain(db, domain, cfg, verdict);
  }

  let duplicates = null;
  if (written.status === 'created' || written.status === 'updated') {
    duplicates = await resolveNearDuplicates(db, written.page_id, cfg);
  }

  await completeItem(db, item.id);
  return { outcome: written.status, verdict: verdict.verdict, queued, duplicates };
}

/**
 * §11.1 gate 3: "A domain accumulating 5 unsafe pages is automatically moved to
 * status = 'blocked' and all of its indexed pages are purged. This is
 * deliberately aggressive."
 */
async function strikeDomain(db, domain, cfg, verdict) {
  const { rows } = await db.query(
    `UPDATE domains SET unsafe_strikes = unsafe_strikes + 1
      WHERE id = $1 RETURNING unsafe_strikes`, [domain.id]);

  const strikes = Number(rows[0]?.unsafe_strikes ?? 0);
  if (strikes < cfg.safety_domain_strike_limit && !verdict.blockDomain) return false;

  await db.query(
    `WITH purged AS (DELETE FROM pages WHERE domain_id = $1),
          dropped AS (DELETE FROM crawl_queue WHERE domain_id = $1)
     UPDATE domains SET status = 'blocked', zone_a_eligible = FALSE WHERE id = $1`,
    [domain.id]);
  await db.query('SELECT bump_index_version($1)', ['safety:auto-block']);

  console.warn(JSON.stringify({
    level: 'warn', at: 'crawl.safety',
    msg: `domain ${domain.host} blocked and purged after ${strikes} unsafe pages`,
  }));
  return true;
}

// text/plain and PDFs have no markup to extract from, so they take the shape the
// rest of the pipeline expects directly. The URL's last path segment stands in
// for a title, because a chunk with no title prefix embeds noticeably worse.
function plainTextToExtracted(fetched) {
  const text = String(fetched.body ?? '').trim();
  return baseExtracted(text, fetched);
}

function pdfToExtracted(pdf, fetched) {
  return { ...baseExtracted(pdf.text, fetched), content_type: 'application/pdf' };
}

function baseExtracted(text, fetched) {
  const url = fetched.final_url ?? '';
  const title = decodeURIComponent((url.split('/').filter(Boolean).pop() ?? '').replace(/\.[a-z0-9]+$/i, ''))
    .replace(/[-_]+/g, ' ').trim() || null;

  return {
    title,
    description: null,
    canonical_url: null,
    author: null,
    published_at: null,
    modified_at: null,
    language: null,
    og_image_url: null,
    robots: { noindex: false, nofollow: false },
    // No headings to find, so the chunker will window on paragraphs alone.
    markdown: text,
    body_text: text,
    word_count: text.split(/\s+/).filter(Boolean).length,
    content_hash: contentHashOf(text),
    links: [],
    outlink_count: 0,
  };
}

function contentHashOf(text) {
  // Same normalisation as everywhere else, so a PDF and its HTML twin dedupe.
  return createHash('sha256')
    .update(String(text ?? '').replace(/\s+/g, ' ').trim()).digest();
}


// ---------------------------------------------------------------------------

export async function run(db = pool, options = {}) {
  const { host = null, tier = null, seed = false, max = Infinity } = options;
  const cfg = await ranking();
  const rules = await loadRules(db);

  await reclaimStale(db);

  const due = await dueDomains(db, { host, tier });
  const domains = new Map(due.map((d) => [Number(d.id), d]));

  const seeded = [];
  if (seed) {
    for (const domain of due) {
      try {
        seeded.push({ host: domain.host, ...(await seedDomain(db, domain)) });
      } catch (err) {
        seeded.push({ host: domain.host, error: err.message });
      }
    }
  }

  // Domains not in the due set can still own queued items -- a link discovered
  // during the last run, for instance. Load whatever the queue actually needs.
  const totals = { fetched: 0, indexed: 0, unchanged: 0, rejected: 0, gone: 0,
                   errors: 0, robots_denied: 0, noindex: 0, queued: 0, duplicates: 0 };
  const perDomain = new Map();

  while (totals.fetched < max) {
    const batch = await claimBatch(db, WORKER_ID, 20);
    if (batch.length === 0) break;

    for (const item of batch) {
      const domainId = Number(item.domain_id);
      if (!domains.has(domainId)) {
        const { rows } = await db.query('SELECT * FROM domains WHERE id = $1', [domainId]);
        if (rows[0]) domains.set(domainId, rows[0]);
      }

      let result;
      try {
        result = await processItem(db, item, { domains, rules, cfg });
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error', at: 'crawl.item', url: item.url, msg: err.message }));
        await deferItem(db, item.id, backoffMs(item.attempts), err.message);
        result = { outcome: 'error', reason: err.message };
      }

      totals.fetched++;
      totals.queued += result.queued ?? 0;
      totals.duplicates += result.duplicates?.duplicates ?? 0;

      switch (result.outcome) {
        case 'created': case 'updated': totals.indexed++; break;
        case 'unchanged': case 'not_modified': totals.unchanged++; break;
        case 'rejected': totals.rejected++; break;
        case 'gone': totals.gone++; break;
        case 'robots_denied': totals.robots_denied++; break;
        case 'noindex': totals.noindex++; break;
        case 'error': totals.errors++; break;
        default: break;
      }

      const d = perDomain.get(domainId) ?? { changed: 0, failed: 0 };
      if (result.outcome === 'created' || result.outcome === 'updated') d.changed++;
      if (result.outcome === 'error') d.failed++;
      perDomain.set(domainId, d);

      if (totals.fetched >= max) break;
    }
  }

  // §9.3 adaptive backoff, once per domain at the end of its run.
  for (const [domainId, counts] of perDomain) {
    const domain = domains.get(domainId);
    if (domain) await finishRun(db, domain, counts);
  }

  return { worker: WORKER_ID, domains_due: due.length, seeded, totals };
}

// Run directly, not imported.
//
// pathToFileURL rather than building the URL by hand: on Windows,
// `file://` + `W:/x.js` produces two slashes where import.meta.url has three,
// so the comparison never matched. The job then did nothing at all -- and hung
// rather than exiting, because importing src/db.js has already opened a
// database that holds the event loop open.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? null;
  const result = await run(pool, {
    host: arg('host'),
    tier: arg('tier'),
    seed: process.argv.includes('--seed'),
    max: Number(arg('max') ?? Infinity),
  });
  console.log(JSON.stringify({ level: 'info', at: 'job.crawl', ...result }, null, 2));
  await pool.end();
}
