// Editorial best bets (R4, §13.4).
//
// "This is the emergency lever. When a sensitive query ranks badly, it is fixed
// in seconds without touching the ranking function."
//
// Two properties matter and are enforced here rather than in the admin console,
// because the console is not the only way rows get in:
//
//   * Maximum 2 per query.
//   * Best bets do not suppress organic results. This module returns a block;
//     it never touches what Zone A retrieved.
//
// A best-bet hit also bypasses the result cache (§13.7), so an editor's change
// is visible on the next request rather than up to 15 minutes later --
// acceptance criterion 17 gives 30 seconds.

const SQL = `
  SELECT b.id, b.match_type, b.pattern, b.target_url, b.target_page_id,
         b.title_override, b.blurb, b.position,
         p.title AS page_title, p.description AS page_description, p.tier,
         d.host, d.display_name
  FROM best_bets b
  LEFT JOIN pages p ON p.id = b.target_page_id
  LEFT JOIN domains d ON d.id = p.domain_id
  WHERE b.active
    AND (b.lang IS NULL OR b.lang = $2)
    AND (b.starts_at IS NULL OR b.starts_at <= now())
    AND (b.ends_at   IS NULL OR b.ends_at   >  now())
    AND (
          (b.match_type = 'exact'  AND b.pattern = $1)
       OR (b.match_type = 'phrase' AND position(lower(b.pattern) in $1) > 0)
       OR (b.match_type = 'regex'  AND $1 ~ b.pattern)
        )
  ORDER BY b.position, b.id
  LIMIT 2`;

/**
 * @param {object} db
 * @param {string} normalized  the normalised query -- patterns are authored
 *                             against this form, which is why the admin console's
 *                             live preview must normalise before it matches.
 * @param {string} lang
 */
export async function matchBestBets(db, normalized, lang) {
  if (!normalized) return [];
  try {
    const { rows } = await db.query(SQL, [normalized, lang]);
    return rows.map((r) => ({
      best_bet_id: Number(r.id),
      url: r.target_url,
      page_id: r.target_page_id ? Number(r.target_page_id) : null,
      title: r.title_override ?? r.page_title ?? r.target_url,
      // The one place in the product where editorial prose appears in results.
      // Hand-written, so P7 is intact: nothing here is machine-generated.
      blurb: r.blurb,
      host: r.host,
      site_name: r.display_name,
      tier: r.tier,
      pinned: true,
    }));
  } catch (err) {
    // A bad regex in one row must not take search down. Postgres raises on an
    // invalid pattern at match time, which is exactly when it is least welcome.
    console.error(JSON.stringify({ level: 'error', at: 'bestbets.match', msg: err.message }));
    return [];
  }
}

/**
 * Validate a pattern before it is stored, so the failure above stays theoretical.
 * Called by the admin create/update endpoint.
 */
export async function validatePattern(db, matchType, pattern) {
  if (!['exact', 'phrase', 'regex'].includes(matchType)) {
    return { ok: false, error: `unknown match_type '${matchType}'` };
  }
  if (!pattern || pattern.length > 500) {
    return { ok: false, error: 'pattern must be 1 to 500 characters' };
  }
  if (matchType === 'regex') {
    try {
      await db.query("SELECT 'x' ~ $1", [pattern]);
    } catch (err) {
      return { ok: false, error: `invalid regular expression: ${err.message}` };
    }
  }
  return { ok: true };
}
