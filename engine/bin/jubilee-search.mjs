#!/usr/bin/env node
// Operator CLI for the things that must not be done by a seed file or by a
// service account: granting Zone A eligibility, issuing webhook secrets, and
// checking the acceptance criteria that can be checked against the database.
//
// Run with:  npm run admin -- <command>

import { randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';

const [, , command, subcommand, ...rest] = process.argv;
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--'))
      .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));

const commands = {
  'domains list': listDomains,
  'domains verify': verifyDomains,
  'domains secret': issueSecret,
  'check': runChecks,
};

const key = subcommand ? `${command} ${subcommand}` : command;
const handler = commands[key];

if (!handler) {
  console.log(`
JubileeSearch operator CLI

  domains list                          list the registry with tier, status and Zone A eligibility
  domains verify --host=<host> --method=<m> --actor=<jubilee-id>
  domains verify --all --method=authoritative_list --actor=<jubilee-id>
                                        grant Zone A eligibility to verified T1 domains
                                        methods: dns_txt | well_known | authoritative_list
  domains secret --host=<host>          issue (or reissue) the publish-webhook shared secret
  check                                 run the acceptance checks that the database can answer
`);
  process.exit(handler === undefined && command ? 1 : 0);
}

try {
  await handler();
} finally {
  await pool.end();
}

async function listDomains() {
  const { rows } = await pool.query(`
    SELECT host, tier, status, ingest_mode,
           zone_a_eligible, verification_method, source_root IS NOT NULL AS has_source,
           webhook_secret IS NOT NULL AS has_secret,
           (SELECT count(*) FROM pages p WHERE p.domain_id = d.id AND p.status = 'indexed') AS indexed
    FROM domains d ORDER BY tier, host`);

  for (const r of rows) {
    console.log([
      r.host.padEnd(30),
      r.tier,
      r.status.padEnd(8),
      r.zone_a_eligible ? 'ZONE-A' : '      ',
      r.has_source ? 'src' : '   ',
      r.has_secret ? 'hmac' : '    ',
      String(r.indexed).padStart(6),
    ].join('  '));
  }
  console.log(`\n${rows.length} domains, ${rows.filter((r) => r.zone_a_eligible).length} Zone A eligible`);
}

async function verifyDomains() {
  const method = flags.method;
  const actor = flags.actor;

  if (!['dns_txt', 'well_known', 'authoritative_list'].includes(method)) {
    fail('--method must be dns_txt, well_known or authoritative_list');
  }
  if (!actor || actor === true) {
    // Section 8.2 calls this a security control. A control with no name attached
    // to it is not a control.
    fail('--actor=<jubilee-id> is required: verification records who attested to it');
  }
  if (!flags.host && !flags.all) fail('pass --host=<host> or --all');

  if (flags.all && method !== 'authoritative_list') {
    fail('--all is only meaningful with --method=authoritative_list, which is an attestation ' +
         'about the whole list. DNS and well-known proofs are per domain.');
  }

  const { rows } = await pool.query(
    `UPDATE domains
        SET zone_a_eligible = TRUE, status = 'active',
            verification_method = $1, verified_at = now(),
            approved_by = $2, approved_at = now(),
            next_crawl_due = COALESCE(next_crawl_due, now())
      WHERE tier = 'T1'
        AND ($3::text IS NULL OR host = $3)
      RETURNING host`,
    [method, actor, flags.host === true ? null : (flags.host ?? null)]);

  if (rows.length === 0) fail('no matching T1 domain');
  console.log(`Verified ${rows.length} domain(s) as ${method}, attested by ${actor}:`);
  for (const r of rows) console.log(`  ${r.host}`);
}

async function issueSecret() {
  if (!flags.host || flags.host === true) fail('--host=<host> is required');
  const secret = randomBytes(32).toString('base64url');

  const { rows } = await pool.query(
    'UPDATE domains SET webhook_secret = $2 WHERE host = $1 RETURNING host', [flags.host, secret]);
  if (rows.length === 0) fail(`no such domain: ${flags.host}`);

  console.log(`Shared secret for ${rows[0].host}:\n\n  ${secret}\n`);
  console.log(
`This is the only time it is printed. No admin read endpoint returns it.
Give it to whoever owns the publishing system for this host, and have them sign
requests as:

  X-Jubilee-Timestamp: <unix seconds>
  X-Jubilee-Signature: sha256=<hmac-sha256 of "<timestamp>.<raw body>" with this secret>

Reissuing invalidates the previous secret immediately.`);
}

// ---------------------------------------------------------------------------
// The subset of section 19 that is a database question rather than a test run.
// The rest -- gold-set recall, the 200 unsafe URLs, latency under load, the
// restore drill -- needs a corpus and a load generator, and is not something a
// CLI can assert on its own.
// ---------------------------------------------------------------------------
async function runChecks() {
  const checks = [
    ['11. Zone A contains only verified T1 pages',
     `SELECT count(*) AS n FROM zone_a_pages p
       WHERE p.tier <> 'T1'
          OR NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = p.domain_id AND d.zone_a_eligible)`],

    ['21. No T3 page is servable unless safety_verdict is safe',
     `SELECT count(*) AS n FROM servable_pages
       WHERE tier = 'T3' AND COALESCE(safety_verdict, 'unclassified') <> 'safe'`],

    ['   T0 quarantine is never servable',
     `SELECT count(*) AS n FROM servable_pages WHERE tier = 'T0'`],

    ['22. No page of a blocked domain remains in the index',
     `SELECT count(*) AS n FROM pages p JOIN domains d ON d.id = p.domain_id
       WHERE d.status = 'blocked'`],

    ['23. A page with enough abuse reports is suppressed',
     `SELECT count(*) AS n FROM (
          SELECT a.page_id FROM abuse_reports a GROUP BY a.page_id
           HAVING count(*) >= (SELECT value FROM ranking_config WHERE key = 'abuse_reports_to_suppress')) r
        JOIN pages p ON p.id = r.page_id
       WHERE NOT p.suppressed`],

    ['   Every chunk carries its model_id',
     `SELECT count(*) AS n FROM chunks WHERE embedded_at IS NOT NULL AND model_id IS NULL`],

    ['   No chunk has exhausted its embedding retries unnoticed',
     `SELECT count(*) AS n FROM chunks WHERE embedded_at IS NULL AND embed_attempts >= 3`],

    ['   No lexicon term doubles the Hebrew article',
     `SELECT count(*) AS n FROM lexicon_terms WHERE has_doubled_hebrew_article(term)`],

    ['27. Admin counts match direct counts',
     `SELECT abs(
          (SELECT count(*) FROM pages WHERE status = 'indexed')
        - (SELECT COALESCE(sum(n), 0) FROM (
             SELECT count(*) AS n FROM pages WHERE status = 'indexed' GROUP BY tier) t)) AS n`],
  ];

  let failures = 0;
  for (const [label, sql] of checks) {
    const { rows } = await pool.query(sql);
    const n = Number(rows[0].n);
    if (n === 0) console.log(`  PASS  ${label}`);
    else { console.log(`  FAIL  ${label}  (${n} offending row${n === 1 ? '' : 's'})`); failures++; }
  }

  // Not a pass/fail, but the number that decides whether the relevance floor is
  // set right. The risk register makes this the tripwire for Zone A.
  const { rows: ctr } = await pool.query(`
    SELECT zone, round(count(*) FILTER (WHERE clicked)::numeric / NULLIF(count(*),0), 4) AS ctr,
           count(*) AS impressions
      FROM result_impressions GROUP BY zone ORDER BY zone`);
  if (ctr.length === 2) {
    const a = Number(ctr.find((r) => r.zone === 'A')?.ctr ?? 0);
    const b = Number(ctr.find((r) => r.zone === 'B')?.ctr ?? 0);
    console.log(`\n  Zone A CTR ${a}  vs  Zone B CTR ${b}`);
    if (a < b) {
      console.log('  WARNING: Zone A CTR is below Zone B CTR. Per the risk register the ' +
                  'relevance floor is too low and must be raised.');
    }
  } else {
    console.log('\n  Zone CTR comparison: not enough logged impressions yet.');
  }

  console.log(failures === 0 ? '\nAll database-checkable criteria pass.'
                             : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
