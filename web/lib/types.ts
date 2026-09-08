// The Search API contract (§14).
//
// This file is the front end's copy of a contract the engine owns. It is not a
// second source of truth: if these disagree with `engine/src/query/`, the engine
// is right and this is stale. It is written down here because §6.1 makes the web
// front end "presentation only. Zero business logic" -- and the one thing a
// presentation layer genuinely needs to know is the shape of what it renders.
//
// Types mirror `GET /api/v1/search` as assembled in
// `engine/src/query/orchestrator.js`.

/** T0 quarantine is never returned, so it does not appear here. */
export type Tier = 'T1' | 'T2' | 'T3';

export type Zone = 'A' | 'B';

export type Intent =
  | 'scripture'
  | 'navigational'
  | 'entity'
  | 'topical'
  | 'conversational';

/**
 * How well the Jubilee network answered (§13.5). Drives how many Zone A results
 * are shown, and `none` means the honest empty state rather than padding.
 */
export type Coverage = 'strong' | 'moderate' | 'weak' | 'none';

/** A "continue this thread" link (R10, §13.9). T1 results only. */
export interface ThreadLink {
  url: string;
  title: string | null;
  via: 'related' | 'character';
}

export interface SearchResult {
  page_id: number;
  url: string;
  title: string | null;
  description: string | null;
  host: string;
  site_name: string | null;
  tier: Tier;
  language: string | null;
  category: string | null;
  persona: string | null;
  office: string | null;
  related_slugs: string[];
  characters: string[];
  published_at: string | null;
  modified_at: string | null;
  zone: Zone;
  score: number;
  /**
   * Always extracted text, never generated (§13.8, P7). May contain `<mark>`
   * from `ts_headline` and nothing else -- see `renderSnippet` in
   * components/Snippet.tsx, which is the only place that tag is let through.
   */
  snippet: string;
  snippet_source: 'headline' | 'chunk';
  /** Position within its own zone, one-based. What the click event reports. */
  position: number;
  thread?: ThreadLink[];
  debug?: ResultDebug;
}

/**
 * Editorial pin (R4, §13.4). Maximum two, rendered above Zone A, visually
 * distinct. The blurb is the one piece of hand-written prose in results.
 */
export interface BestBet {
  best_bet_id: number;
  url: string;
  page_id: number | null;
  title: string;
  blurb: string | null;
  host: string | null;
  site_name: string | null;
  tier: Tier | null;
  pinned: true;
}

/**
 * Scripture card (R3, §13.2). Quoted verbatim from the JSV, never paraphrased.
 * The engine omits the card entirely rather than render an uncertain passage, so
 * a null here is a decision and not a loading state.
 */
export interface ScriptureCard {
  reference: string;
  verses: { verse: number; text: string }[];
  citation: string;
  chapter_url: string | null;
}

/** Entity panel (R10, §7.8). Text only, verbatim from JubileePedia. */
export interface EntityPanel {
  key: string;
  type: string;
  name: string;
  summary: string | null;
  facts: { label: string; value: string }[];
  related: { url: string; title: string }[];
  source_url: string;
  source_name: string;
}

export interface NavigationalResult {
  host: string;
  title: string;
  url: string;
  deep_links: { url: string; title: string | null }[];
}

export interface ZoneABlock {
  label: string;
  coverage: Coverage;
  results: SearchResult[];
  empty_state: boolean;
}

export interface ZoneBBlock {
  label: string;
  results: SearchResult[];
  /** What retrieval actually found, not an extrapolation (P7). */
  total_estimate: number;
}

export interface SearchResponse {
  query: string;
  intent: Intent;
  lang: string;
  best_bets: BestBet[];
  scripture_card: ScriptureCard | null;
  entity_panel: EntityPanel | null;
  navigational: NavigationalResult | null;
  /** null when the caller asked for the other zone only. */
  zone_a: ZoneABlock | null;
  zone_b: ZoneBBlock | null;
  suggestions: string[];
  cache_hit: boolean;
  /** Needed to report a click against this result set (R7). */
  query_id: number | null;
  took_ms: number;
  debug?: SearchDebug;
}

// --- debug (§14, P4) --------------------------------------------------------
// Returned only for a caller holding `search_admin`. Every result must be able
// to answer "why was this returned, in which zone, and why at this position".

export interface ResultDebug {
  zone_reason: string;
  rrf: {
    lexical_rank: number | null;
    semantic_rank: number | null;
    lexical_contribution: number;
    semantic_contribution: number;
    k: number;
    intent_weights: { lexical: number; semantic: number };
    total: number;
  };
  vector_distance: number | null;
  boosts: Record<string, number>;
  signals: Record<string, number | null>;
  score_after_boost: number;
  rerank?: {
    cross_encoder_score: number | null;
    fusion_position: number;
    reranked_position: number;
    delta: number;
  };
}

export interface SearchDebug {
  normalized: string;
  routable: string;
  detected_language: string;
  intent: Intent;
  scripture_reference: string | null;
  expansion: {
    concepts: string[];
    groups: { weight: number; terms: string[] }[];
  };
  fusion_weights: { lexical: number; semantic: number };
  vector_path: string;
  rerank: { zone_a: boolean; zone_b: boolean };
  candidates: { zone_a: number; zone_b: number };
  coverage_thresholds: { strong: number; moderate: number; floor: number };
  cache_key: string;
  cache_bypassed: boolean;
}

// --- other endpoints --------------------------------------------------------

export interface SuggestResponse {
  suggestions: string[];
}

export interface ClickEvent {
  query_id: number;
  page_id: number;
  zone: Zone;
  position: number;
  type: 'click';
}

export interface AbuseReport {
  url: string;
  reason: string;
  note?: string;
}

/** Filters accepted by GET /api/v1/search (§14). */
export interface SearchParams {
  q: string;
  zones?: Zone[];
  tier?: ('T2' | 'T3')[];
  lang?: string;
  site?: string;
  category?: string;
  persona?: string;
  page?: number;
  size?: number;
  rerank?: boolean;
  debug?: boolean;
  session?: string;
}
