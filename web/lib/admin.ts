import 'server-only';
import { getSession, isAdmin, canView, type Session } from './session';
import { engineOrigin } from './api';

// Server-side client for the admin API (§15).
//
// Two rules hold everywhere in this file.
//
// **The engine is the authority, not this app.** Every admin route already
// requires a bearer token carrying `search_admin` or `search_viewer`, and
// refuses without one. Nothing here grants anything; the checks below decide
// what to *render*, and hiding a button the engine would refuse anyway is a
// courtesy to the reader, not a control.
//
// **The token stays on the server.** It lives in an httpOnly cookie, is read
// here, and is attached to the engine call. It never reaches the browser, so no
// admin screen can leak it through a devtools network tab or a client bundle.

const ENGINE = engineOrigin();
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS ?? 8000);

export class NotAuthorised extends Error {
  constructor(public readonly reason: 'anonymous' | 'insufficient') {
    super(reason === 'anonymous' ? 'not signed in' : 'lacks the search_admin right');
    this.name = 'NotAuthorised';
  }
}

export class AdminRequestFailed extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(detail || `the engine returned ${status}`);
    this.name = 'AdminRequestFailed';
  }
}

/**
 * The session, or a typed refusal. Read-only screens accept a viewer; anything
 * that writes demands the admin right.
 *
 * Called at the top of every server action as well as in the layout. The Next
 * docs are explicit that a Server Action is reachable by direct POST regardless
 * of what the UI renders, so the layout gate is not the control -- this is.
 */
export async function requireSession(level: 'view' | 'admin'): Promise<Session> {
  const session = await getSession();
  if (!session) throw new NotAuthorised('anonymous');
  const ok = level === 'admin' ? isAdmin(session) : canView(session);
  if (!ok) throw new NotAuthorised('insufficient');
  return session;
}

async function call<T>(
  path: string,
  { level = 'view', method = 'GET', body }:
    { level?: 'view' | 'admin'; method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await requireSession(level);

  let res: Response;
  try {
    res = await fetch(`${ENGINE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    throw new AdminRequestFailed(0, err instanceof Error ? err.message : 'engine unreachable');
  }

  if (res.status === 401 || res.status === 403) {
    // The engine disagreed with us about the rights on this token -- most often
    // because it expired. Treated as a sign-in problem, not a server error.
    throw new NotAuthorised(res.status === 401 ? 'anonymous' : 'insufficient');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* no body */ }
    throw new AdminRequestFailed(res.status, detail);
  }
  return (await res.json()) as T;
}

// --- shapes ------------------------------------------------------------------
// Counts arrive from Postgres as strings (bigint), which is why every numeric
// field below is `string | number` and the screens run them through `num()`.

type Count = string | number | null;

export interface Dashboard {
  pages_by_tier: Record<string, Count> | null;
  indexed_24h: Count;
  embedding_backlog: Count;
  safety_queue: Count;
  failing_domains: Count;
  pending_domains: Count;
  zone_a_domains: Count;
  webhooks_24h: Count;
  webhook_failures_24h: Count;
  p95_latency_ms: Count;
  cache_hit_rate: Count;
  zone_a_empty_rate: Count;
  zero_result_queries_7d: Count;
}

export interface Domain {
  id: number; host: string; display_name: string | null; tier: string; status: string;
  ingest_mode: string; source_root: string | null; url_template: string | null; owner_org: string | null;
  crawl_interval_hours: Count; max_pages: Count; max_depth: Count; crawl_delay_ms: Count;
  respect_robots: boolean; render_js: boolean; language_hint: string | null;
  zone_a_eligible: boolean; approved_by: string | null; verification_method: string | null;
  verified_at: string | null; unsafe_strikes: Count; consecutive_failures: Count;
  last_crawl_finished: string | null; next_crawl_due: string | null;
  has_webhook_secret: boolean; indexed_pages: Count;
}

export interface SafetyReview {
  id: number; page_id: number; machine_score: Count; machine_reasons: unknown;
  notes: string | null; created_at: string; url: string; title: string | null;
  tier: string; safety_verdict: string | null; body_excerpt: string | null;
  host: string; age_hours: Count;
}

export interface Candidate {
  id: number; host: string; target_tier: string; source: string; status: string;
  linking_domains: Count; nominated_by: string | null; nomination_note: string | null;
  sample_urls: string[] | null; review_notes: string | null; reviewed_by: string | null;
  reviewed_at: string | null; first_seen_at: string; age_days: Count;
  probe_pages: Count; probe_passed: Count;
}

export interface RankingKey {
  key: string; value: Count; description: string | null;
  updated_by: string | null; updated_at: string | null;
}
export interface RankingChange {
  key: string; old_value: Count; new_value: Count; actor: string | null; at: string;
}

export interface BestBet {
  id: number; match_type: string; pattern: string; lang: string | null;
  target_url: string; title_override: string | null; blurb: string | null;
  position: Count; active: boolean; starts_at: string | null; ends_at: string | null;
  created_by: string | null; created_at: string; revisions: Count;
}

export interface LexiconTerm {
  id: number; term: string; lang: string; register: string | null;
  weight: Count; is_primary: boolean;
}
export interface LexiconConcept {
  id: number; concept_key: string; gloss: string | null; notes: string | null;
  active: boolean; terms: LexiconTerm[] | null;
}

export interface BlocklistSource {
  source: string; entries: Count; hard_blocks: Count; allow_overrides: Count;
  last_load: string | null; last_outcome: string | null; last_written: Count;
  last_error: string | null;
}
export interface BlocklistEntry {
  id: number; pattern: string; match_type: string; category: string | null;
  severity: Count; added_at: string;
}
export interface BlocklistLoad {
  source: string; started_at: string; finished_at: string | null;
  entries_parsed: Count; entries_written: Count; outcome: string | null; error: string | null;
}

export interface ZoneCtrRow { zone: string; impressions: Count; clicks: Count; ctr: Count }
export interface ZeroResultRow {
  normalized: string; lang: string | null; intent: string | null;
  times: Count; last_seen: string;
}

export interface PageExplain {
  id: number; url: string; status: string; tier: string; safety_verdict: string | null;
  safety_reasons: unknown; suppressed: boolean; word_count: Count; language: string | null;
  has_hash: boolean; last_fetched_at: string | null; last_indexed_at: string | null;
  fetch_failures: Count; host: string; domain_status: string; zone_a_eligible: boolean;
  chunks: Count; embedded_chunks: Count; servable: boolean; why_not_servable: string | null;
}

// --- reads -------------------------------------------------------------------

export const getDashboard = () => call<Dashboard>('/api/v1/admin/dashboard');

export const getDomains = (params?: { tier?: string; status?: string }) => {
  const q = new URLSearchParams();
  if (params?.tier) q.set('tier', params.tier);
  if (params?.status) q.set('status', params.status);
  return call<{ domains: Domain[] }>(`/api/v1/admin/domains${q.size ? `?${q}` : ''}`);
};

export const getSafetyQueue = () =>
  call<{ queue: SafetyReview[]; target_latency_hours: number }>('/api/v1/admin/safety/queue');

export const getCandidates = (params?: { tier?: string; status?: string }) => {
  const q = new URLSearchParams();
  if (params?.tier) q.set('tier', params.tier);
  if (params?.status) q.set('status', params.status);
  return call<{ candidates: Candidate[] }>(`/api/v1/admin/candidates${q.size ? `?${q}` : ''}`);
};

export const getRanking = () =>
  call<{ config: RankingKey[]; recent_changes: RankingChange[] }>('/api/v1/admin/ranking');

export const getBestBets = () => call<{ best_bets: BestBet[] }>('/api/v1/admin/best-bets');

export const getLexicon = () => call<{ concepts: LexiconConcept[] }>('/api/v1/admin/lexicon');

export const getBlocklists = () => call<{
  sources: BlocklistSource[];
  manual_entries: BlocklistEntry[];
  recent_loads: BlocklistLoad[];
}>('/api/v1/admin/blocklists');

export const getZoneCtr = () => call<{
  zones: ZoneCtrRow[]; zone_a_below_zone_b: boolean; note: string | null;
}>('/api/v1/admin/analytics/zone-ctr');

export const getZeroResults = (days = 7) =>
  call<{ days: number; queries: ZeroResultRow[] }>(
    `/api/v1/admin/analytics/zero-results?days=${days}`);

export const explainUrl = (target: string) =>
  call<PageExplain>(`/api/v1/admin/index/explain?url=${encodeURIComponent(target)}`);

// --- writes ------------------------------------------------------------------
// Each demands the admin right, and the engine demands it again.

export const verifyDomain = (id: number, method: string) =>
  call<Domain>(`/api/v1/admin/domains/${id}/verify`, { level: 'admin', method: 'POST', body: { method } });

export const purgeDomain = (id: number, block: boolean) =>
  call<{ host: string; pages_purged: Count }>(
    `/api/v1/admin/domains/${id}/purge`, { level: 'admin', method: 'POST', body: { block } });

export const addDomain = (body: Record<string, unknown>) =>
  call<Domain>('/api/v1/admin/domains', { level: 'admin', method: 'POST', body });

export const decideSafety = (id: number, verdict: string, notes?: string) =>
  call<{ review_id: number; verdict: string }>(
    `/api/v1/admin/safety/${id}`, { level: 'admin', method: 'POST', body: { verdict, notes } });

export const approveCandidate = (id: number, notes?: string) =>
  call<Record<string, unknown>>(
    `/api/v1/admin/candidates/${id}/approve`, { level: 'admin', method: 'POST', body: { notes } });

export const rejectCandidate = (id: number, notes?: string) =>
  call<Record<string, unknown>>(
    `/api/v1/admin/candidates/${id}/reject`, { level: 'admin', method: 'POST', body: { notes } });

export const nominateCandidate = (body: Record<string, unknown>) =>
  call<Candidate>('/api/v1/admin/candidates', { level: 'admin', method: 'POST', body });

export const updateRanking = (changes: Record<string, number>) =>
  call<{ changed: { key: string; value: number }[] }>(
    '/api/v1/admin/ranking', { level: 'admin', method: 'PUT', body: changes });

export const createBestBet = (body: Record<string, unknown>) =>
  call<BestBet>('/api/v1/admin/best-bets', { level: 'admin', method: 'POST', body });

export const deactivateBestBet = (id: number) =>
  call<BestBet>(`/api/v1/admin/best-bets/${id}/deactivate`, { level: 'admin', method: 'POST' });

export const addLexiconTerm = (body: Record<string, unknown>) =>
  call<LexiconTerm>('/api/v1/admin/lexicon/terms', { level: 'admin', method: 'POST', body });

export const addBlocklistEntry = (body: Record<string, unknown>) =>
  call<BlocklistEntry>('/api/v1/admin/blocklists/entries', { level: 'admin', method: 'POST', body });

export const deleteBlocklistEntry = (id: number) =>
  call<{ deleted: number }>(
    `/api/v1/admin/blocklists/entries/${id}`, { level: 'admin', method: 'DELETE' });

export const bumpIndexVersion = () =>
  call<{ index_version: number }>('/api/v1/admin/index/bump-version', { level: 'admin', method: 'POST' });

export const dedupeIndex = () =>
  call<{ duplicates_marked: number }>('/api/v1/admin/index/dedupe', { level: 'admin', method: 'POST' });

export const sweepCache = () =>
  call<{ rows_swept: number }>('/api/v1/admin/index/sweep-cache', { level: 'admin', method: 'POST' });

/** Postgres bigints arrive as strings; every screen renders through this. */
// --- the endpoints added for the console's remaining screens (routes/admin-ops.js)

export interface ImportResult {
  total: number; inserted?: number; updated?: number; failed: number;
  results?: { host: string; ok: boolean; inserted?: boolean; error?: string }[];
  concepts_created?: number; terms_written?: number;
  errors?: { term: string; error: string }[];
}
export interface BestBetAudit {
  id: number; best_bet_id: number; action: string; actor: string;
  before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null; at: string;
}
export interface LexiconPreview {
  query: string; normalized: string; lang: string; concepts: string[];
  groups: { weight: number; terms: string[] }[];
}
export interface IndexLog {
  url: string;
  domain: { host: string; status: string; ingest_mode: string; last_crawl_started: string | null;
            last_crawl_finished: string | null; next_crawl_due: string | null } | null;
  page: { id: number } | null;
  ingest_runs: { id: number; mode: string; started_at: string; finished_at: string | null;
                 pages_seen: Count; pages_changed: Count; pages_failed: Count; error: string | null }[];
  crawl_failures: { status: number | null; reason: string; outcome: string; at: string }[];
  queue: { priority: number; source: string; scheduled_for: string; claimed_by: string | null;
           claimed_at: string | null; attempts: number; last_error: string | null }[];
}
export interface AnalyticsOverview {
  days: number;
  by_intent: { intent: string; searches: Count; zero_results: Count }[];
  by_language: { lang: string; searches: Count }[];
  ctr_by_position: { zone: string; position: number; impressions: Count; clicks: Count; ctr: Count }[];
  concept_hits: { concept_key: string; hits: Count }[];
  top_queries: { normalized: string; times: Count; zone_a_empty: Count }[];
}

export const updateDomain = (id: number, patch: Record<string, unknown>) =>
  call<Domain>(`/api/v1/admin/domains/${id}`, { level: 'admin', method: 'PUT', body: patch });
export const pauseDomain = (id: number, paused: boolean) =>
  call<Domain>(`/api/v1/admin/domains/${id}/pause`, { level: 'admin', method: 'POST', body: { paused } });
export const reingestDomain = (id: number) =>
  call<{ host: string; pages_reset: number; queued: number }>(
    `/api/v1/admin/domains/${id}/reingest`, { level: 'admin', method: 'POST', body: {} });
export const importDomains = (csv: string) =>
  call<ImportResult>('/api/v1/admin/domains/import', { level: 'admin', method: 'POST', body: { csv } });
export const issueVerificationToken = (id: number) =>
  call<{ host: string; token: string; dns_txt: string; well_known_url: string }>(
    `/api/v1/admin/domains/${id}/verification-token`, { level: 'admin', method: 'POST', body: {} });

export const updateBestBet = (id: number, patch: Record<string, unknown>) =>
  call<BestBet>(`/api/v1/admin/best-bets/${id}`, { level: 'admin', method: 'PUT', body: patch });
export const reorderBestBets = (order: number[]) =>
  call<{ reordered: number }>('/api/v1/admin/best-bets/reorder', { level: 'admin', method: 'POST', body: { order } });
export const getBestBetAudit = (limit = 50) =>
  call<{ entries: BestBetAudit[] }>(`/api/v1/admin/best-bets/audit?limit=${limit}`);

export const previewLexicon = (q: string, lang?: string) =>
  call<LexiconPreview>(`/api/v1/admin/lexicon/preview?q=${encodeURIComponent(q)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`);
export const importLexicon = (csv: string) =>
  call<ImportResult>('/api/v1/admin/lexicon/import', { level: 'admin', method: 'POST', body: { csv } });

export const reindex = (target: { url?: string; host?: string }) =>
  call<{ pages_reset: number; queued: number }>('/api/v1/admin/index/reindex', { level: 'admin', method: 'POST', body: target });
export const purgePage = (url: string) =>
  call<{ purged: boolean }>('/api/v1/admin/index/purge-page', { level: 'admin', method: 'POST', body: { url } });
export const reembed = (target: { url?: string; host?: string }) =>
  call<{ chunks_reset: number }>('/api/v1/admin/index/reembed', { level: 'admin', method: 'POST', body: target });
export const indexLog = (url: string) =>
  call<IndexLog>(`/api/v1/admin/index/log?url=${encodeURIComponent(url)}`);

export const getAnalyticsOverview = (days = 7) =>
  call<AnalyticsOverview>(`/api/v1/admin/analytics/overview?days=${days}`);

export const num = (v: Count | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
