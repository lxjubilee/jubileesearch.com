import Link from 'next/link';
import type { Coverage, Intent, SearchResponse } from '@/lib/types';
import Icon, { type IconName } from './ResultsIcons';

// The right-hand column of the results page: Search Insights and the follow-up
// button.
//
// EVERY LINE HERE IS SOMETHING THE ENGINE SAID. The insights are the engine's
// own classification of the query (intent), its own judgement of how well the
// network answered (coverage), and the counts it returned — put into words by
// a fixed table, not composed. P7 forbids generated prose in results, so there
// is no summary, no "sentiment", and no theme list here until the engine sends
// one; a row with nothing behind it is left out rather than filled in.

export const INTENT: Record<Intent, { label: string; lead: string }> = {
  scripture: { label: 'Scripture lookup', lead: 'Your search looks like a Bible reference.' },
  navigational: { label: 'Finding a site', lead: 'Your search looks like you are after a particular site.' },
  entity: { label: 'A person, place or subject', lead: 'Your search names a person, place or subject.' },
  topical: { label: 'Exploring a topic', lead: 'Your search looks like you are exploring a topic.' },
  conversational: { label: 'Asking a question', lead: 'Your search reads like a question.' },
};

export const COVERAGE: Record<Coverage, string> = {
  strong: 'Strong — the network covers this well',
  moderate: 'Moderate — some Jubilee writing on this',
  weak: 'Light — little Jubilee writing on this yet',
  none: 'Not yet covered by the Jubilee network',
};

/** Where "Ask Follow-up Question" goes: a new conversation with Jubilee. */
const FOLLOW_UP = 'https://www.jubileeinspire.com/chat?new=1';

export default function ResultsAside({ response }: { response: SearchResponse }) {
  const intent = INTENT[response.intent];
  const fromJubilee = response.zone_a?.results.length ?? 0;
  const fromWeb = response.zone_b?.results.length ?? 0;

  const rows: { icon: IconName; title: string; text: string }[] = [];
  if (intent) rows.push({ icon: 'target', title: 'Search type', text: intent.label });
  if (response.zone_a) rows.push({ icon: 'star', title: 'Jubilee coverage', text: COVERAGE[response.zone_a.coverage] });
  rows.push({
    icon: 'layers',
    title: 'What came back',
    text: `${fromJubilee} from Jubilee · ${fromWeb} from the web`,
  });

  return (
    <section className="rs-panel rs-insights" aria-labelledby="rs-insights-heading">
      <div className="rs-panel-head">
        <Icon name="chart" className="rs-panel-icon" />
        <h2 id="rs-insights-heading">Search Insights</h2>
      </div>
      {intent && <p className="rs-insights-lead">{intent.lead}</p>}

      <ul className="rs-insight-list">
        {rows.map((row) => (
          <li className="rs-insight" key={row.title}>
            <Icon name={row.icon} className="rs-insight-icon" />
            <div>
              <span className="rs-insight-title">{row.title}</span>
              <span className="rs-insight-text">{row.text}</span>
            </div>
          </li>
        ))}
      </ul>

      {response.suggestions.length > 0 && (
        <div className="rs-related">
          <span className="rs-related-label">Related searches</span>
          {response.suggestions.map((s) => (
            <Link key={s} href={`/search?${new URLSearchParams({ q: s })}`} className="rs-related-link">
              <Icon name="search" />{s}
            </Link>
          ))}
        </div>
      )}

      <a className="rs-followup" href={FOLLOW_UP} rel="noopener">
        <Icon name="chat" />
        <span>Ask Follow-up Question</span>
        <Icon name="arrow" className="rs-followup-arrow" />
      </a>
    </section>
  );
}
