import type { SearchResult, Zone } from '@/lib/types';
import Snippet from './Snippet';

// One result. A server component — it holds no state, and click logging is
// handled once for the whole list by ResultTelemetry, which reads the data
// attributes below rather than putting a listener on every card.
//
// There is no image here, at any tier. That is principle P10 and acceptance
// criterion 15, and the favicon the static site fetched per result is gone: it
// was an image in a result card, and it announced the reader to every domain in
// the list. A letter on a disc does the same job and tells nobody.

const hostname = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

const truncate = (url: string) => (url.length > 60 ? `${url.slice(0, 57)}...` : url);

export default function ResultCard({ result, zone }: { result: SearchResult; zone: Zone }) {
  const host = hostname(result.url);

  return (
    <article
      className="result-item"
      data-page-id={result.page_id}
      data-zone={zone}
      data-position={result.position}
    >
      <div className="result-title-row">
        <div className="result-favicon-placeholder" aria-hidden="true">
          {host.charAt(0).toUpperCase()}
        </div>
        <a
          href={result.url}
          className="result-title"
          data-result-link
          target="_blank"
          rel="noopener"
        >
          {result.title ?? result.url}
        </a>
      </div>

      <div className="result-url-line">
        <span className="result-site-name-link">{result.site_name ?? host}</span>
        <span className="result-url-separator">›</span>
        <span className="result-url-link">{truncate(result.url)}</span>
        {/* Acceptance criterion 14: Zone B is always labelled as wider-web
            content, and T2 is distinguishable from T3 within it. */}
        {zone === 'B' && result.tier && (
          <span
            className="result-tier"
            title={result.tier === 'T2' ? 'Approved faith-based site' : 'Open web, safety screened'}
          >
            {result.tier === 'T2' ? 'Approved' : 'Open web'}
          </span>
        )}
      </div>

      <p className="result-snippet"><Snippet text={result.snippet} /></p>

      {/* Thread continuation (R10, §13.9). T1 only, up to three. The engine
          decides which links these are; the page only renders them. */}
      {result.thread && result.thread.length > 0 && (
        <nav className="result-thread" aria-label="Continue this thread">
          <span className="result-thread-label">Continue this thread</span>
          {result.thread.map((link) => (
            <a key={link.url} href={link.url} className="result-thread-link">
              {link.title ?? link.url}
            </a>
          ))}
        </nav>
      )}

      <button type="button" className="result-report" data-report-url={result.url}>
        Report this result
      </button>
    </article>
  );
}
