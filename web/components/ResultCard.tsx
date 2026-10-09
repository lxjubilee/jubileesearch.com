import type { SearchResult, Zone } from '@/lib/types';
import Icon from './ResultsIcons';
import Snippet from './Snippet';

// One result. A server component — it holds no state, and click logging is
// handled once for the whole list by ResultTelemetry, which reads the data
// attributes below rather than putting a listener on every card.
//
// There is no image here, at any tier. That is principle P10 and acceptance
// criterion 15. The banner on a Jubilee card and the tile on a web card are
// CSS gradients with text on them: they give the card the shape of the design
// without loading anything, and they announce the reader to nobody.
//
// Two shapes, one per zone. A Jubilee result is a tall card with a title banner;
// a wider-web result is a row with a lettered tile. The difference is part of
// how the reader learns which block is the network's own.

const hostname = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

/**
 * A stable hue per site, so one site's cards share a banner colour and a page
 * of results is not a single repeated gradient. Kept to blues, violets, teals
 * and the warm sunrise band — the palette the design is drawn in.
 */
const HUES = [212, 228, 248, 268, 192, 176, 28, 38];
function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length] ?? 212;
}

/** Zone B is always labelled (acceptance criterion 14), and T2 reads apart from T3. */
const TIER_LABEL: Record<string, { text: string; title: string }> = {
  T2: { text: 'Approved site', title: 'Approved faith-based site' },
  T3: { text: 'Open web', title: 'Open web, safety screened' },
};

export default function ResultCard({ result, zone }: { result: SearchResult; zone: Zone }) {
  const host = hostname(result.url);
  const site = result.site_name ?? host;
  const title = result.title ?? result.url;
  const hue = { '--card-hue': hueFor(host) } as React.CSSProperties;

  const report = (
    <button type="button" className="result-report" data-report-url={result.url}>
      Report
    </button>
  );

  if (zone === 'A') {
    return (
      <article
        className="result-item rs-card"
        data-page-id={result.page_id}
        data-zone={zone}
        data-position={result.position}
      >
        <div className="rs-banner" style={hue} aria-hidden="true">
          <span className="rs-banner-title">{title}</span>
          <span className="rs-banner-site">{site}</span>
          <span className="rs-badge-jubilee"><Icon name="star" />Jubilee</span>
        </div>

        <div className="rs-card-body">
          <a href={result.url} className="result-title" data-result-link target="_blank" rel="noopener">
            {title}
          </a>
          <span className="rs-card-host">{host}</span>
          <p className="result-snippet"><Snippet text={result.snippet} /></p>

          {/* Thread continuation (R10, §13.9). T1 only, up to three. The engine
              decides which links these are; the page only renders them. */}
          {result.thread && result.thread.length > 0 && (
            <nav className="result-thread" aria-label="Continue this thread">
              <span className="result-thread-label">Continue</span>
              {result.thread.map((link) => (
                <a key={link.url} href={link.url} className="result-thread-link">
                  {link.title ?? link.url}
                </a>
              ))}
            </nav>
          )}
        </div>

        <footer className="rs-card-foot">
          {result.category && <span className="rs-chip">{result.category}</span>}
          <span className="rs-trust"><Icon name="check" />Trusted by Jubilee</span>
          {report}
        </footer>
      </article>
    );
  }

  const tier = TIER_LABEL[result.tier];
  return (
    <article
      className="result-item rs-row"
      data-page-id={result.page_id}
      data-zone={zone}
      data-position={result.position}
    >
      <div className="rs-tile" style={hue} aria-hidden="true">
        {site.charAt(0).toUpperCase()}
      </div>

      <div className="rs-row-body">
        <div className="rs-row-head">
          <a href={result.url} className="result-title" data-result-link target="_blank" rel="noopener">
            {title}
          </a>
          <Icon name="external" className="rs-ext" />
        </div>
        <span className="rs-card-host">{host}</span>
        <p className="result-snippet"><Snippet text={result.snippet} /></p>
        <footer className="rs-card-foot">
          {result.category && <span className="rs-chip">{result.category}</span>}
          {tier && (
            <span className={`rs-tier rs-tier-${result.tier}`} title={tier.title}>
              <Icon name="shield" />{tier.text}
            </span>
          )}
          {report}
        </footer>
      </div>
    </article>
  );
}
