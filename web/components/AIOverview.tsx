import type { SearchResponse } from '@/lib/types';
import { aiOverview } from '@/lib/ai-overview';
import Icon, { type IconName } from './ResultsIcons';
import Overview from './Overview';
import { COVERAGE, INTENT } from './ResultsAside';

// The AI Overview panel. An async server component, rendered inside its own
// Suspense boundary in search/page.tsx: the results stream to the reader first,
// and this panel replaces its loading state when Claude has answered.
//
// Every search gets an answer. Sentences backed by a Jubilee page carry its
// numbered citation; sentences from Claude's own knowledge carry none, and the
// panel says so in words whenever there are any. Only a failure or a decline
// falls back to the quoted Overview. See lib/ai-overview.ts for the rules.

export default async function AIOverview({ query, response }: { query: string; response: SearchResponse }) {
  const overview = await aiOverview(query, response.zone_a?.results ?? []);
  if (!overview) return <Overview response={response} />;

  const intent = INTENT[response.intent];
  const chips: { icon: IconName; label: string; value: string }[] = [];
  if (intent) chips.push({ icon: 'target', label: 'Likely intent', value: intent.label });
  if (overview.themes.length) chips.push({ icon: 'sparkle', label: 'Key themes', value: overview.themes.join(' · ') });
  if (response.zone_a) chips.push({ icon: 'star', label: 'Jubilee coverage', value: COVERAGE[response.zone_a.coverage].split(' — ')[0] ?? '' });

  // Only the sources a sentence actually cites are listed.
  const cited = overview.sources.filter((s) => overview.sentences.some((x) => x.sources.some((c) => c.n === s.n)));
  const uncited = overview.sentences.some((x) => x.sources.length === 0);
  const basis = cited.length === 0
    ? 'No Jubilee page covers this yet, so this answer is from Claude’s general knowledge.'
    : uncited
      ? 'Numbered parts come from the Jubilee pages listed; the rest is Claude’s general knowledge.'
      : null;

  return (
    <section className="rs-overview" aria-labelledby="rs-overview-heading">
      <div className="rs-overview-text">
        <div className="rs-hero-head">
          <Icon name="sparkle" className="rs-hero-icon" />
          <div>
            <h2 id="rs-overview-heading" className="rs-hero-kicker">AI Overview</h2>
            <span className="rs-hero-sub">Written by Claude · can make mistakes</span>
          </div>
        </div>

        <p className="rs-ai-text">
          {overview.sentences.map((s, i) => (
            <span key={i}>
              {s.text}
              {s.sources.map((src) => (
                <a
                  key={src.n}
                  href={src.url}
                  className="rs-cite"
                  target="_blank"
                  rel="noopener"
                  title={`${src.title} · ${src.site}`}
                >
                  {src.n}
                </a>
              ))}{' '}
            </span>
          ))}
        </p>

        {basis && <p className="rs-ai-basis">{basis}</p>}

        {cited.length > 0 && <ol className="rs-ai-sources">
          {cited.map((s) => (
            <li key={s.n} value={s.n}>
              <a href={s.url} target="_blank" rel="noopener">{s.title}</a>
              <span> · {s.site}</span>
            </li>
          ))}
        </ol>}

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
      <div className="rs-hero-art" aria-hidden="true" />
    </section>
  );
}

/** Shown while Claude writes: the panel's frame, so nothing below moves when it lands. */
export function AIOverviewLoading() {
  return (
    <section className="rs-overview rs-overview-loading" aria-busy="true" aria-label="Writing the AI Overview">
      <div className="rs-overview-text">
        <div className="rs-hero-head">
          <Icon name="sparkle" className="rs-hero-icon" />
          <div>
            <span className="rs-hero-kicker">AI Overview</span>
            <span className="rs-hero-sub">Reading the Jubilee pages…</span>
          </div>
        </div>
        <div className="rs-ai-skel" style={{ width: '92%' }} />
        <div className="rs-ai-skel" style={{ width: '86%' }} />
        <div className="rs-ai-skel" style={{ width: '64%' }} />
      </div>
      <div className="rs-hero-art" aria-hidden="true" />
    </section>
  );
}
