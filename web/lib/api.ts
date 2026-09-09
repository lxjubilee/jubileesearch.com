import 'server-only';
import type { SearchParams, SearchResponse } from './types';
import { getSession } from './session';

// Server-side client for the engine (§14).
//
// Only ever called from a server component or a route handler. The engine sits
// on its own port and, in production, behind api.jubileesearch.com; going to it
// directly from the server saves the browser a round trip and means the first
// paint already contains the results. That matters for more than speed:
// acceptance criterion 12 requires Zone A above Zone B "in any client", and a
// server-rendered page satisfies it before a single line of JavaScript runs.
//
// Client-side calls (suggest, click events, abuse reports) go through the
// rewrite in next.config.ts instead, so they stay same-origin.

const ENGINE = (process.env.ENGINE_API_URL ?? 'http://127.0.0.1:4038').replace(/\/$/, '');

const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS ?? 5000);

export class EngineUnavailable extends Error {
  constructor(public readonly detail: string) {
    super('the search engine is not answering');
    this.name = 'EngineUnavailable';
  }
}

function toQuery(params: SearchParams): string {
  const q = new URLSearchParams({ q: params.q });
  if (params.zones?.length) q.set('zones', params.zones.join(','));
  if (params.tier?.length) q.set('tier', params.tier.join(','));
  if (params.lang) q.set('lang', params.lang);
  if (params.site) q.set('site', params.site);
  if (params.category) q.set('category', params.category);
  if (params.persona) q.set('persona', params.persona);
  if (params.page && params.page > 1) q.set('page', String(params.page));
  if (params.size) q.set('size', String(params.size));
  if (params.rerank === false) q.set('rerank', 'false');
  if (params.debug) q.set('debug', 'true');
  if (params.session) q.set('session', params.session);
  return q.toString();
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // The access token is attached here and only here.
  //
  // It lives in an httpOnly cookie and is read on the server, so it never
  // reaches the browser's JavaScript -- and this is the only call that needs
  // it. §17 makes the engine record `jubilee_id` "only where the user is
  // signed in", and §14 gives an authenticated session 300 searches a minute
  // rather than 60; both are decided by whether this header is present.
  //
  // The client-side calls (/suggest, /event, /report) deliberately stay
  // anonymous. A click event is already tied to a query_id the engine logged
  // with the identity, so sending the token again would add nothing but
  // exposure.
  const session = await getSession();

  try {
    const res = await fetch(`${ENGINE}/api/v1/search?${toQuery(params)}`, {
      signal: controller.signal,
      ...(session ? { headers: { authorization: `Bearer ${session.access_token}` } } : {}),
      // The engine has its own result cache keyed on far more than the URL
      // (§13.7: the expansion set, the filters, the index version). Caching the
      // same response again in Next would add a second, dumber layer that
      // cannot be invalidated when an editor changes a lexicon term.
      cache: 'no-store',
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new EngineUnavailable(body.error ?? `engine returned ${res.status}`);
    }
    return (await res.json()) as SearchResponse;
  } catch (err) {
    if (err instanceof EngineUnavailable) throw err;
    const detail = err instanceof Error
      ? (err.name === 'AbortError' ? `no response within ${TIMEOUT_MS}ms` : err.message)
      : String(err);
    throw new EngineUnavailable(detail);
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthResponse {
  status: string;
  index: { indexed_pages: number; embedding_backlog: number; index_version: number };
  // Why `embedding_backlog` may never move. With no Inference API configured,
  // nothing is embedded and search runs on word overlap alone -- a query that
  // shares no words with a page returns nothing, which reads as a broken engine
  // rather than a missing dependency.
  inference: {
    configured: boolean;
    search_mode: 'hybrid' | 'lexical-only';
    embedding_model: string;
  };
}

export async function health(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${ENGINE}/api/v1/health`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as HealthResponse) : null;
  } catch {
    return null;
  }
}

/**
 * Pass a reader's content request to the engine (§13.5, §10.3).
 *
 * Called from the route handler, not the browser, so nothing about the reader
 * travels with it: no session cookie, no bearer token, no forwarded IP. That is
 * the point rather than an oversight -- see 017_content_requests.sql. The engine
 * stores what was wanted, never who wanted it.
 */
export async function contentRequest(
  input: { q: string; note?: string; lang?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE}/api/v1/content-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const engineOrigin = () => ENGINE;
