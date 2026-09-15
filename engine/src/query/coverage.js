// Zone sizing and host diversity (§13.5).
//
// "The floor is the discipline that makes this work. A Zone A that shows five
// irrelevant Jubilee pages on every query teaches users to skip the block
// entirely, which destroys exactly the priority it was built to protect."
//
// The risk register rates "Zone A becomes noise because the relevance floor is
// too low" as High/High, and the tripwire it gives is concrete: if Zone A CTR
// falls below Zone B CTR, the floor is wrong and must be raised immediately.
// That comparison is available from result_impressions once the click loop is
// logging, and is a dashboard metric (§15 screen 8), not something this module
// can enforce on its own.

/**
 * Decide how many Zone A results to show from the strength of the best one.
 *
 * @param {number|null} topScore  best Zone A score after rerank, null if nothing retrieved
 * @param {object} cfg
 * @returns {{size: number, coverage: 'strong'|'moderate'|'weak'|'none'}}
 */
export function zoneASize(topScore, cfg) {
  if (topScore === null || topScore === undefined || !Number.isFinite(topScore)) {
    return { size: 0, coverage: 'none' };
  }
  if (topScore >= cfg.zone_a_strong_threshold) {
    return { size: Math.min(5, cfg.zone_a_max_results), coverage: 'strong' };
  }
  if (topScore >= cfg.zone_a_moderate_threshold) {
    return { size: Math.min(3, cfg.zone_a_max_results), coverage: 'moderate' };
  }
  if (topScore >= cfg.zone_a_relevance_floor) {
    return { size: Math.min(2, cfg.zone_a_max_results), coverage: 'weak' };
  }
  // Below the floor Zone A shows nothing and says so. Padding to five is the
  // failure this whole mechanism exists to prevent.
  return { size: 0, coverage: 'none' };
}

/**
 * Cap results per host, preserving score order (§13.5, "Host diversity").
 *
 * Applied before the size cut, not after: if one property has written the eight
 * best pages on a topic, the reader should see three of them and then something
 * else, not three results where five were warranted.
 */
export function diversify(results, maxPerHost) {
  if (!maxPerHost || maxPerHost < 1) return results;
  const seen = new Map();
  const kept = [];
  for (const r of results) {
    const n = seen.get(r.host) ?? 0;
    if (n >= maxPerHost) continue;
    seen.set(r.host, n + 1);
    kept.push(r);
  }
  return kept;
}

/**
 * Widget ordering (§14).
 *
 * "In widget mode Zone A is the host site first, then the rest of the network,
 * then Zone B."
 *
 * A stable partition, so relevance order survives inside each half: the host
 * site's results in the order retrieval ranked them, then the network's in the
 * order retrieval ranked them. Sorting by host would throw the ranking away.
 *
 * Subdomains count as the host site. A widget on blog.example.com asking for
 * example.com should treat the blog's own pages as local, which is the same
 * rule `crawl/policy.js` uses to decide what belongs to a domain.
 */
export function preferSite(results, host) {
  if (!host) return results;
  const site = String(host).toLowerCase().replace(/^www\./, '');
  const isLocal = (r) => {
    const h = String(r.host ?? '').toLowerCase().replace(/^www\./, '');
    return h === site || h.endsWith(`.${site}`);
  };
  return [...results.filter(isLocal), ...results.filter((r) => !isLocal(r))];
}

/**
 * Assemble Zone A: diversify, size by coverage, cut.
 * Returns the block in the shape the API contract gives for `zone_a`.
 *
 * `preferSite` reorders for display *after* the size is decided, never before.
 * Coverage sizing reads the top result's score to judge how well the network
 * answered (§13.5); if the host site's best result were moved to the front
 * first, a widget on a site with one weak local page would read as weak
 * coverage and shrink Zone A, when the network's actual best answer was strong.
 * The size is a fact about the query; the order is a fact about the caller.
 */
/**
 * The Zone A relevance gate on the cross-encoder's own scale (OPEN-ITEMS §4).
 *
 * The fused score is RRF, which is rank-derived and carries no magnitude, so
 * no floor on it can tell "best of a good set" from "best of nothing". The
 * cross-encoder score can: it is a judgement about THIS query and THIS page.
 * When the reranker ran and `zone_a_cross_encoder_floor` is set (exactly -1 means
 * off; cross-encoder logits are often negative, so anything else is a floor),
 * a Zone A whose best page scores below the floor is emptied rather than
 * padded. The honest empty state is the product decision (§13.5); this is the
 * mechanism that finally lets it fire on an off-topic query.
 *
 * Results below the floor are dropped individually as well, so a strong first
 * result is not followed by two that the reranker judged irrelevant.
 */
export function crossEncoderGate(results, cfg, { lexiconHit = false } = {}) {
  const floor = Number(cfg.zone_a_cross_encoder_floor);
  if (!Number.isFinite(floor) || floor === -1) return { results, gated: false };
  // A query the lexicon recognises is in the corpus's own vocabulary, so Zone A
  // is on-topic by construction and the gate stands down. This is also where
  // the cross-encoder is weakest: "ruach hakodesh" against English titles is
  // the register bridge (R2) the product exists for, and measured on the
  // network corpus the reranker scored all fifty on-topic candidates below the
  // floor. Off-topic queries -- pizza, laptops, chromodynamics -- hit no
  // concept, so they are still gated.
  if (lexiconHit) return { results, gated: false };
  if (!results.some((r) => Number.isFinite(r.rerank_score))) return { results, gated: false };
  const kept = results.filter((r) => !Number.isFinite(r.rerank_score) || r.rerank_score >= floor);
  return { results: kept, gated: kept.length < results.length };
}

export function assembleZoneA(results, cfg, { preferHost = null, lexiconHit = false } = {}) {
  const gate = crossEncoderGate(results, cfg, { lexiconHit });
  const diverse = diversify(gate.results, cfg.zone_a_max_per_host);
  const { size, coverage } = zoneASize(diverse[0]?.score ?? null, cfg);
  return {
    label: 'From Jubilee',
    coverage,
    results: preferSite(diverse.slice(0, size), preferHost).map(withPosition),
    // Copy for the empty state is a front-end concern -- §13.5 asks for it to be
    // "warm and honest", which is editorial, not structural. The API says only
    // that coverage is 'none' and offers the suggestion hook.
    empty_state: size === 0,
  };
}

export function assembleZoneB(results, cfg, { page = 1 } = {}) {
  const diverse = diversify(results, cfg.zone_b_max_per_host);
  const size = cfg.zone_b_max_results;
  const start = (page - 1) * size;
  return {
    label: 'From the wider web',
    results: diverse.slice(start, start + size).map(withPosition),
    // An honest count of what retrieval actually found, not an extrapolation.
    // P7 forbids fabricating text; inventing "about 4,300,000 results" is the
    // same instinct applied to a number.
    total_estimate: diverse.length,
  };
}

// `rerank_score` is an internal signal for the gate above; the debug block
// already carries the cross-encoder score for anyone entitled to see it.
const withPosition = ({ rerank_score: _score, rerank_text: _text, ...r }, i) => ({ ...r, position: i + 1 });
