import type { Metadata } from 'next';
import Link from 'next/link';
import { search, EngineUnavailable } from '@/lib/api';
import SearchBox from '@/components/SearchBox';
import ScopeChips from '@/components/ScopeChips';
import ResultTelemetry from '@/components/ResultTelemetry';
import { ZoneA, ZoneB } from '@/components/Zones';
import { BestBets, ScriptureCard, EntityPanel, Navigational } from '@/components/Panels';
import SiteFooter from '@/components/SiteFooter';

// The results page.
//
// A server component that fetches from the engine and renders the two zones
// into the HTML. That is the substantive gain of this port over the static
// site: the results arrive in the document rather than being fetched by the
// browser after paint. There is no loading flash, no layout shift when the
// results land, and — the reason it matters here rather than being a nicety —
// acceptance criterion 12 holds before a single line of JavaScript runs.
//
// §6.1 governs how much this file is allowed to do: "Presentation only. Zero
// business logic." Nothing here scores, ranks, filters or decides how many
// results a zone shows. The engine has already made every one of those
// decisions and this renders the answer.

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = first((await searchParams).q)?.trim();
  return {
    title: q ? `${q}` : 'Search',
    // A results page is not something another engine should index; the header
    // in next.config.ts says the same thing to a crawler that ignores this.
    robots: { index: false, follow: false },
  };
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const query = (first(params.q) ?? '').trim();
  const scope = first(params.zones) === 'A' ? 'jubilee' : 'all';

  if (!query) {
    return (
      <div className="results-container">
        <ResultsHeader query="" />
        <main id="results" className="results-list">
          <div className="no-results">
            <p>Type something to search.</p>
            <p><Link href="/">Back to JubileeSearch</Link></p>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  let response;
  try {
    response = await search({
      q: query,
      zones: scope === 'jubilee' ? ['A'] : undefined,
    });
  } catch (error) {
    // The engine being down is not the reader's problem to debug, but it is
    // also not something to disguise as "no results found" — that would teach
    // them the network has nothing on a subject it may cover well.
    const detail = error instanceof EngineUnavailable ? error.detail : String(error);
    return (
      <div className="results-container">
        <ResultsHeader query={query} />
        <main id="results" className="results-list">
          <div className="no-results">
            <p>Search is temporarily unavailable.</p>
            <p>Nothing is wrong with what you searched for. Please try again shortly.</p>
            {process.env.NODE_ENV !== 'production' && (
              <p style={{ marginTop: 16, fontSize: 12, color: '#5f6368' }}>{detail}</p>
            )}
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const zoneA = response.zone_a;
  const zoneB = response.zone_b;
  const total = (zoneA?.results.length ?? 0) + (zoneB?.results.length ?? 0);
  const seconds = (response.took_ms / 1000).toFixed(2);

  return (
    <div className="results-container">
      <ResultsHeader query={query} />

      <div id="stats" className="results-stats">
        {total === 0
          ? `No results (${seconds} seconds)`
          : `${total} result${total === 1 ? '' : 's'} (${seconds} seconds)`}
        {response.cache_hit && ' · cached'}
      </div>

      <main id="results" className="results-list">
        {/* Order is the guarantee. Cards and panels above, then Zone A, then
            Zone B — in the document, not in a stylesheet. */}
        {response.scripture_card && <ScriptureCard card={response.scripture_card} />}
        {response.navigational && <Navigational nav={response.navigational} />}
        {response.entity_panel && <EntityPanel entity={response.entity_panel} />}
        <BestBets bets={response.best_bets} />

        <ScopeChips query={query} zones={scope} />

        <ResultTelemetry queryId={response.query_id}>
          {zoneA && <ZoneA block={zoneA} />}
          {zoneB && <ZoneB block={zoneB} />}
        </ResultTelemetry>

        {total === 0 && !response.scripture_card && response.best_bets.length === 0 && (
          <div className="no-results">
            <p>Nothing matched <strong>{query}</strong>.</p>
            <p>Try different words, or fewer of them.</p>
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}

function ResultsHeader({ query }: { query: string }) {
  return (
    <header className="results-header">
      <div className="results-header-inner">
        <Link href="/" className="results-logo">
          Jubilee<span className="highlight">Search</span>
        </Link>
        <SearchBox initialQuery={query} variant="results" />
      </div>
    </header>
  );
}
