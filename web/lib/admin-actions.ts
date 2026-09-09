'use server';

import { revalidatePath } from 'next/cache';
import * as admin from './admin';
import { NotAuthorised, AdminRequestFailed } from './admin';

// Every write the console can make (§15).
//
// **A Server Action is a POST endpoint.** The Next docs are blunt about it:
// these are reachable by direct request whether or not the UI ever rendered a
// button, so authorization is checked *inside each one* -- via the `level:
// 'admin'` argument each client call carries -- and never inferred from the
// layout having let someone through. The engine then checks the token's rights
// again, independently. Two gates, neither trusting the other.
//
// Actions return a result object rather than throwing, so a screen can show what
// failed in place instead of replacing itself with an error boundary. An
// operator who has just typed a ranking weight should not lose the page.

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function run(
  what: string,
  fn: () => Promise<unknown>,
  revalidate: string,
): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath(revalidate);
    return { ok: true, message: what };
  } catch (err) {
    if (err instanceof NotAuthorised) {
      return {
        ok: false,
        message: err.reason === 'anonymous'
          ? 'Your session has expired. Sign in again.'
          : 'This account does not carry search_admin, so nothing was changed.',
      };
    }
    if (err instanceof AdminRequestFailed) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : 'unknown failure' };
  }
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const int = (f: FormData, k: string) => Number.parseInt(str(f, k), 10);

// --- screen 2: domains -------------------------------------------------------

export async function verifyDomainAction(_: ActionResult | null, form: FormData) {
  const id = int(form, 'id');
  const method = str(form, 'method');
  return run(
    `Verified. The domain is now Zone A eligible via ${method}.`,
    () => admin.verifyDomain(id, method),
    '/admin/domains',
  );
}

export async function purgeDomainAction(_: ActionResult | null, form: FormData) {
  const id = int(form, 'id');
  const block = str(form, 'block') === 'true';
  return run(
    block
      ? 'Domain blocked and every page of it removed from the index.'
      : 'Domain purged. Its pages are gone; the registration remains.',
    () => admin.purgeDomain(id, block),
    '/admin/domains',
  );
}

export async function addDomainAction(_: ActionResult | null, form: FormData) {
  const host = str(form, 'host');
  const tier = str(form, 'tier');
  if (!host) return { ok: false, message: 'A host is required.' };
  return run(
    `${host} registered at ${tier}, pending verification. §8.2 means it is not in Zone A until verified.`,
    () => admin.addDomain({
      host,
      tier,
      display_name: str(form, 'display_name') || null,
      owner_org: str(form, 'owner_org') || null,
      ingest_mode: str(form, 'ingest_mode') || undefined,
      source_root: str(form, 'source_root') || null,
      language_hint: str(form, 'language_hint') || null,
    }),
    '/admin/domains',
  );
}

// --- screen 3: lexicon -------------------------------------------------------

export async function addLexiconTermAction(_: ActionResult | null, form: FormData) {
  const term = str(form, 'term');
  const weightRaw = str(form, 'weight');
  return run(
    `Added "${term}".`,
    () => admin.addLexiconTerm({
      concept_key: str(form, 'concept_key'),
      term,
      lang: str(form, 'lang'),
      register: str(form, 'register') || null,
      weight: weightRaw ? Number(weightRaw) : null,
      is_primary: str(form, 'is_primary') === 'on',
    }),
    '/admin/lexicon',
  );
}

// --- screen 4: best bets -----------------------------------------------------

export async function createBestBetAction(_: ActionResult | null, form: FormData) {
  const pattern = str(form, 'pattern');
  const positionRaw = str(form, 'position');
  return run(
    `Best bet created for "${pattern}". It bypasses the cache, so it is live on the next search.`,
    () => admin.createBestBet({
      match_type: str(form, 'match_type'),
      pattern,
      lang: str(form, 'lang') || null,
      target_url: str(form, 'target_url'),
      title_override: str(form, 'title_override') || null,
      blurb: str(form, 'blurb') || null,
      position: positionRaw ? Number(positionRaw) : 1,
    }),
    '/admin/best-bets',
  );
}

export async function deactivateBestBetAction(_: ActionResult | null, form: FormData) {
  return run('Best bet deactivated.', () => admin.deactivateBestBet(int(form, 'id')), '/admin/best-bets');
}

// --- screen 5: whitelist review ---------------------------------------------

/**
 * Approve or reject, from one form.
 *
 * Both verdicts share a decision note, and a note belongs to the decision
 * whichever way it goes -- so this is one form with two submit values rather
 * than two forms. (Two forms would also have to be siblings: a form nested
 * inside another form is invalid HTML and the inner one is dropped.)
 */
export async function decideCandidateAction(_: ActionResult | null, form: FormData) {
  const id = int(form, 'id');
  const host = str(form, 'host');
  const tier = str(form, 'target_tier');
  const notes = str(form, 'notes') || undefined;

  if (str(form, 'decision') === 'reject') {
    return run(
      `${host} rejected. Anything a probe had already fetched has been purged.`,
      () => admin.rejectCandidate(id, notes),
      '/admin/candidates',
    );
  }

  return run(
    tier === 'T2'
      ? `${host} approved into T2 and registered. It is not Zone A eligible — §8.2 reserves that for verified T1.`
      : `${host} approved for a probe. It enters at T0 with a page cap and nothing of it is servable until the sample passes the safety gates.`,
    () => admin.approveCandidate(id, notes),
    '/admin/candidates',
  );
}

export async function nominateCandidateAction(_: ActionResult | null, form: FormData) {
  const host = str(form, 'host');
  if (!host) return { ok: false, message: 'A host is required.' };
  return run(
    `${host} nominated for review.`,
    () => admin.nominateCandidate({
      host,
      target_tier: str(form, 'target_tier'),
      note: str(form, 'note') || null,
    }),
    '/admin/candidates',
  );
}

// --- screen 6: safety queue --------------------------------------------------

export async function decideSafetyAction(_: ActionResult | null, form: FormData) {
  const verdict = str(form, 'verdict');
  const words: Record<string, string> = {
    approve: 'Approved. The page is servable again.',
    reject: 'Rejected. The page is out of the index.',
    block_domain: 'Domain blocked and every page of it purged.',
  };
  return run(
    words[verdict] ?? 'Recorded.',
    () => admin.decideSafety(int(form, 'id'), verdict, str(form, 'notes') || undefined),
    '/admin/safety',
  );
}

// --- screen 7: blocklists ----------------------------------------------------

export async function addBlocklistEntryAction(_: ActionResult | null, form: FormData) {
  const pattern = str(form, 'pattern');
  return run(
    `Rule added for "${pattern}".`,
    () => admin.addBlocklistEntry({
      pattern,
      match_type: str(form, 'match_type'),
      category: str(form, 'category') || null,
      severity: Number(str(form, 'severity') || '100'),
    }),
    '/admin/blocklists',
  );
}

export async function deleteBlocklistEntryAction(_: ActionResult | null, form: FormData) {
  return run(
    'Manual rule removed.',
    () => admin.deleteBlocklistEntry(int(form, 'id')),
    '/admin/blocklists',
  );
}

// --- screen 9: ranking controls ---------------------------------------------

export async function updateRankingAction(_: ActionResult | null, form: FormData) {
  // Only keys whose value actually changed are sent. Writing every key back
  // would fill the audit log with entries that changed nothing and make the
  // one-click revert useless for finding what a person actually did.
  const changes: Record<string, number> = {};
  for (const [name, raw] of form.entries()) {
    if (!name.startsWith('key:')) continue;
    const key = name.slice(4);
    const value = Number(String(raw));
    const previous = Number(String(form.get(`was:${key}`) ?? ''));
    if (Number.isFinite(value) && value !== previous) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, message: 'Nothing changed.' };
  }
  const names = Object.keys(changes).join(', ');
  return run(
    `Updated ${names}. The index version was bumped, so nothing is served under the old weights.`,
    () => admin.updateRanking(changes),
    '/admin/ranking',
  );
}

export async function revertRankingAction(_: ActionResult | null, form: FormData) {
  const key = str(form, 'key');
  const value = Number(str(form, 'to'));
  if (!key || !Number.isFinite(value)) return { ok: false, message: 'Nothing to revert to.' };
  return run(
    `${key} reverted to ${value}.`,
    () => admin.updateRanking({ [key]: value }),
    '/admin/ranking',
  );
}

// --- screen 10: index tools --------------------------------------------------

export async function bumpVersionAction(): Promise<ActionResult> {
  try {
    const r = await admin.bumpIndexVersion();
    revalidatePath('/admin/index-tools');
    return { ok: true, message: `Index version is now ${r.index_version}. Every cached result is stale.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'failed' };
  }
}

export async function dedupeAction(): Promise<ActionResult> {
  try {
    const r = await admin.dedupeIndex();
    revalidatePath('/admin/index-tools');
    return { ok: true, message: `${r.duplicates_marked} duplicate page(s) marked.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'failed' };
  }
}

export async function sweepCacheAction(): Promise<ActionResult> {
  try {
    const r = await admin.sweepCache();
    revalidatePath('/admin/index-tools');
    return { ok: true, message: `${r.rows_swept} expired cache row(s) swept.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'failed' };
  }
}
