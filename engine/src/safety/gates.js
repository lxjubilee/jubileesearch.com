// Safety classification (§11).
//
// "This is the highest-risk subsystem in the build. If it fails, JubileeSearch
// returns something a child should not see on a ministry site. Design it
// defensively."
//
// The defensive shape here is that every function returns a verdict, no function
// returns "probably fine", and the only verdict that reaches the index is one
// that came back explicitly safe. `evaluate` returns 'reject' for an error it
// did not expect, because the alternative -- treating an exception as a pass --
// is how a default-deny system quietly becomes default-allow.
//
// Acceptance criterion 20: a test set of at least 200 known-unsafe URLs is
// classified with 100% rejection. Anything less blocks release of T3.
//
// §11.2, and this is a constraint on what this module may grow into: image
// fetching, thumbnailing, storage and NSFW image classification "are not built
// and must not be built". There is no image path here to extend.

import { ranking } from '../config.js';
import { classifyContent } from '../inference/client.js';

export const VERDICTS = { SAFE: 'safe', UNSAFE: 'unsafe', REVIEW: 'review', UNCLASSIFIED: 'unclassified' };

// §11.1 gate 1 and gate 2 both read blocklist_entries. Loaded once per pass
// rather than per URL: at T3 volumes this is a few thousand rows and re-reading
// them per page would dominate the cost of classification.
export async function loadRules(db) {
  const { rows } = await db.query(
    'SELECT pattern, match_type, category, severity FROM blocklist_entries');
  return {
    // severity 0 is the allow convention (migration 024): a host whose whole
    // purpose is publishing the text the keyword rules trip on.
    allowHosts: new Set(rows.filter((r) => r.severity === 0 && r.match_type === 'host')
                            .map((r) => r.pattern.toLowerCase())),
    hosts: rows.filter((r) => r.severity > 0 && r.match_type === 'host'),
    suffixes: rows.filter((r) => r.severity > 0 && r.match_type === 'suffix'),
    regexes: rows.filter((r) => r.severity > 0 && r.match_type === 'regex')
                 .map((r) => ({ ...r, re: safeRegex(r.pattern) })).filter((r) => r.re),
    keywords: rows.filter((r) => r.severity > 0 && r.match_type === 'keyword'),
  };
}

function safeRegex(pattern) {
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

/**
 * Gate 1: domain reputation, before a single request is spent.
 * @returns {{blocked: boolean, reasons: object[]}}
 */
export function gateDomain(host, rules) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (rules.allowHosts.has(h)) return { blocked: false, reasons: [], allowlisted: true };

  const reasons = [];
  for (const rule of rules.hosts) {
    if (h === rule.pattern.toLowerCase() || h.endsWith(`.${rule.pattern.toLowerCase()}`)) {
      reasons.push({ gate: 1, rule: rule.pattern, category: rule.category, severity: rule.severity });
    }
  }
  for (const rule of rules.suffixes) {
    if (h.endsWith(rule.pattern.toLowerCase())) {
      reasons.push({ gate: 1, rule: rule.pattern, category: rule.category, severity: rule.severity });
    }
  }
  return { blocked: reasons.some((r) => r.severity >= 100), reasons, allowlisted: false };
}

/**
 * Gate 2: URL and metadata heuristics, before and after fetch.
 *
 * §11.1: "Heuristics are fast and cheap but noisy, so they route to review
 * rather than automatic rejection unless the term is on the hard list." A
 * severity-100 keyword rejects; anything lower accumulates toward review.
 *
 * The scripture problem (migration 024) is why the soft list exists at all: a
 * commentary on Judges 19 must reach a human, not a rejection.
 */
export function gateHeuristics({ url, title, description }, rules, { allowlisted = false } = {}) {
  if (allowlisted) return { blocked: false, score: 0, reasons: [] };

  const haystack = [url, title, description].filter(Boolean).join(' ').toLowerCase();
  const reasons = [];
  let score = 0;

  for (const rule of rules.keywords) {
    if (haystack.includes(rule.pattern.toLowerCase())) {
      reasons.push({ gate: 2, rule: rule.pattern, category: rule.category, severity: rule.severity });
      score += rule.severity;
    }
  }
  for (const rule of rules.regexes) {
    if (rule.re.test(url ?? '')) {
      reasons.push({ gate: 2, rule: rule.pattern, category: rule.category, severity: rule.severity });
      score += rule.severity;
    }
  }

  return { blocked: reasons.some((r) => r.severity >= 100), score, reasons };
}

/**
 * Gate 3: content classification through the Inference API, and the threshold
 * table from §11.1.
 *
 *   safe, confidence >= 0.90        index into T3
 *   safe, confidence 0.70 to 0.89   queue for human review
 *   safe, confidence < 0.70         reject
 *   unsafe, any confidence          reject, and strike the domain
 *
 * All three thresholds are runtime configurable, per the spec.
 */
export async function gateContent(bodyText, cfg) {
  const result = await classifyContent(bodyText);

  if (!result) {
    // The classifier could not be reached or answered malformed. P1: uncertain
    // means excluded. The page stays in T0 and is retried, not admitted.
    return {
      verdict: VERDICTS.UNCLASSIFIED,
      score: null,
      reasons: [{ gate: 3, reason: 'classifier unavailable or malformed response' }],
    };
  }

  const confidence = Number(result.confidence);
  const reasons = [{
    gate: 3, safe_for_family: result.safe_for_family, confidence,
    categories: result.categories, flags: result.flags, reason: result.reason,
  }];

  if (!result.safe_for_family) {
    return { verdict: VERDICTS.UNSAFE, score: 0, reasons, strike: true };
  }
  if (confidence >= cfg.safety_auto_index_confidence) {
    return { verdict: VERDICTS.SAFE, score: round2(confidence * 100), reasons };
  }
  if (confidence >= cfg.safety_review_confidence) {
    return { verdict: VERDICTS.REVIEW, score: round2(confidence * 100), reasons };
  }
  return { verdict: VERDICTS.UNSAFE, score: round2(confidence * 100), reasons };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Run the gates for a page, in order, stopping at the first failure.
 *
 * §11.1: "Every T3 page passes through all gates in order. Failing any gate ends
 * the process with exclusion. T2 pages run gates 1, 2, and 4 as a spot check.
 * T1 pages skip gates entirely."
 */
export async function evaluate({ tier, host, url, title, description, bodyText }, rules, cfg) {
  if (tier === 'T1') {
    return { verdict: VERDICTS.SAFE, score: 100, reasons: [{ gate: 0, reason: 'T1 owned content is trusted' }] };
  }

  try {
    const domain = gateDomain(host, rules);
    if (domain.blocked) {
      return { verdict: VERDICTS.UNSAFE, score: 0, reasons: domain.reasons, blockDomain: true };
    }

    const heuristics = gateHeuristics({ url, title, description }, rules, domain);
    if (heuristics.blocked) {
      return { verdict: VERDICTS.UNSAFE, score: 0, reasons: [...domain.reasons, ...heuristics.reasons] };
    }

    if (tier === 'T2') {
      // Gates 1, 2 and 4 only. A T2 domain was approved by a human editor, so
      // gate 3 is not run per page -- but heuristic hits still reach gate 4.
      const spotCheck = heuristics.reasons.length > 0;
      return {
        verdict: spotCheck ? VERDICTS.REVIEW : VERDICTS.SAFE,
        score: Math.max(0, 100 - heuristics.score),
        reasons: [...domain.reasons, ...heuristics.reasons],
      };
    }

    const content = await gateContent(bodyText, cfg);
    return {
      ...content,
      reasons: [...domain.reasons, ...heuristics.reasons, ...content.reasons],
    };
  } catch (err) {
    // An unexpected failure is a rejection, not a pass.
    return {
      verdict: VERDICTS.UNSAFE, score: 0,
      reasons: [{ gate: null, reason: `classification error: ${err.message}` }],
    };
  }
}

/**
 * Apply a verdict to a page, and to its domain's strike counter.
 *
 * §11.1: "A domain accumulating 5 unsafe pages is automatically moved to
 * status = 'blocked' and all of its indexed pages are purged. This is
 * deliberately aggressive." It is meant to be.
 */
export async function applyVerdict(db, pageId, result, cfg = null) {
  const config = cfg ?? await ranking();

  const status = result.verdict === VERDICTS.SAFE ? 'indexed'
    : result.verdict === VERDICTS.REVIEW ? 'quarantined'
    : result.verdict === VERDICTS.UNCLASSIFIED ? 'quarantined'
    : 'rejected';

  const { rows } = await db.query(
    `UPDATE pages
        SET safety_verdict = $2, safety_score = $3, safety_reasons = $4::jsonb, status = $5
      WHERE id = $1
      RETURNING domain_id`,
    [pageId, result.verdict, result.score, JSON.stringify(result.reasons), status]);

  const domainId = rows[0]?.domain_id;
  if (!domainId) return { applied: false };

  if (result.verdict === VERDICTS.REVIEW || result.verdict === VERDICTS.UNCLASSIFIED) {
    await db.query(
      `INSERT INTO safety_reviews (page_id, machine_score, machine_reasons)
       VALUES ($1, $2, $3::jsonb)`,
      [pageId, result.score, JSON.stringify(result.reasons)]);
  }

  if (result.verdict === VERDICTS.UNSAFE) {
    const { rows: strike } = await db.query(
      `UPDATE domains SET unsafe_strikes = unsafe_strikes + 1
        WHERE id = $1 RETURNING unsafe_strikes, host`, [domainId]);

    if (Number(strike[0].unsafe_strikes) >= config.safety_domain_strike_limit || result.blockDomain) {
      await db.query(
        `WITH purged AS (DELETE FROM pages WHERE domain_id = $1)
         UPDATE domains SET status = 'blocked', zone_a_eligible = FALSE WHERE id = $1`,
        [domainId]);
      await db.query('SELECT bump_index_version($1)', ['safety:auto-block']);
      return { applied: true, domain_blocked: strike[0].host };
    }
  }

  return { applied: true, verdict: result.verdict };
}

/**
 * Gate 5: ongoing revalidation. "A random 1% sample of the T3 index is
 * reclassified weekly as an audit, and the pass rate is a tracked metric."
 */
export async function auditSample(db, fraction = 0.01) {
  const rules = await loadRules(db);
  const cfg = await ranking();

  const { rows } = await db.query(
    `SELECT p.id, p.url, p.title, p.description, p.body_text, p.tier, d.host
       FROM pages p JOIN domains d ON d.id = p.domain_id
      WHERE p.tier = 'T3' AND p.status = 'indexed'
      ORDER BY random()
      LIMIT GREATEST(1, (SELECT count(*) FROM pages WHERE tier = 'T3' AND status = 'indexed') * $1)`,
    [fraction]);

  let passed = 0;
  for (const page of rows) {
    const result = await evaluate({
      tier: page.tier, host: page.host, url: page.url,
      title: page.title, description: page.description, bodyText: page.body_text,
    }, rules, cfg);
    if (result.verdict === VERDICTS.SAFE) passed++;
    else await applyVerdict(db, page.id, result, cfg);
  }

  return {
    sampled: rows.length,
    passed,
    pass_rate: rows.length ? Math.round((passed / rows.length) * 1000) / 10 : null,
  };
}
