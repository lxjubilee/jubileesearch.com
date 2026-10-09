import type { SearchResponse } from '@/lib/types';
import Icon, { type IconName } from './ResultsIcons';
import { COVERAGE, INTENT } from './ResultsAside';

// The Overview panel at the top of the results — the mockup's "AI Overview",
// built without AI.
//
// P7 (setup/initial_setup.md): "The engine indexes, ranks, and quotes extracted
// text. It does not summarize doctrine, generate answers, or synthesize
// claims." So nothing here is written by a machine. The body is the top Jubilee
// results' own descriptions — written by each page's author, stored by the
// crawler — quoted word for word, each credited and linked to its source. The
// chips under it are the engine's classification of the search, through the
// same fixed wording the Search Insights panel uses.
//
// Decided 2026-10-09: an overview that quotes rather than generates. A generated
// summary needs P7 changed by the spec's owner first, and a model the engine
// does not have.

const MAX_QUOTES = 3;

export default function Overview({ response }: { response: SearchResponse }) {
  const seen = new Set<string>();
  const quotes = (response.zone_a?.results ?? [])
    .filter((r) => {
      const text = r.description?.trim();
      if (!text || seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .slice(0, MAX_QUOTES);

  // Nothing to quote is nothing to show — an empty overview would be a panel
  // that only says the network had nothing, which Zone A already says.
  if (quotes.length === 0) return null;

  const intent = INTENT[response.intent];
  const chips: { icon: IconName; label: string; value: string }[] = [];
  if (intent) chips.push({ icon: 'target', label: 'Likely intent', value: intent.label });
  if (response.zone_a) chips.push({ icon: 'star', label: 'Jubilee coverage', value: COVERAGE[response.zone_a.coverage].split(' — ')[0] ?? '' });
  chips.push({ icon: 'book', label: 'Sources', value: `${quotes.length} Jubilee ${quotes.length === 1 ? 'page' : 'pages'}` });

  return (
    <section className="rs-overview" aria-labelledby="rs-overview-heading">
      <div className="rs-overview-text">
        <div className="rs-hero-head">
          <Icon name="sparkle" className="rs-hero-icon" />
          <div>
            <h2 id="rs-overview-heading" className="rs-hero-kicker">Overview</h2>
            <span className="rs-hero-sub">In the words of the Jubilee network</span>
          </div>
        </div>

        <ul className="rs-quotes">
          {quotes.map((r) => (
            <li key={r.page_id} className="rs-quote">
              <q>{r.description}</q>
              <a href={r.url} className="rs-quote-source" target="_blank" rel="noopener">
                {r.title ?? r.host} <span>· {r.site_name ?? r.host}</span>
              </a>
            </li>
          ))}
        </ul>

        <div className="rs-overview-chips">
          {chips.map((c) => (
            <div className="rs-ochip" key={c.label}>
              <Icon name={c.icon} />
              <div>
                <span className="rs-ochip-label">{c.label}</span>
                <span className="rs-ochip-value">{c.value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* The sunrise side, shared with the scripture panel: gradients, not a photograph (P10). */}
      <div className="rs-hero-art" aria-hidden="true" />
    </section>
  );
}
