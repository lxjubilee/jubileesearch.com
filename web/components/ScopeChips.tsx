import Link from 'next/link';
import Icon, { type IconName } from './ResultsIcons';
import styles from './ScopeChips.module.css';

// The "All results" / "Jubilee only" filter chips (§13.5, user controls).
//
// Links, not buttons. The scope is in the URL, which means it is shareable,
// back-button-able, survives a reload, and works with JavaScript disabled — and
// it means the server does the filtering, by asking the engine for Zone A only,
// rather than the browser hiding a block it was already sent.
//
// Default is both zones, per §13.5.

export default function ScopeChips({ query, zones }: { query: string; zones: 'all' | 'jubilee' }) {
  const href = (scope: 'all' | 'jubilee') => {
    const params = new URLSearchParams({ q: query });
    if (scope === 'jubilee') params.set('zones', 'A');
    return `/search?${params}`;
  };

  const chip = (scope: 'all' | 'jubilee', label: string, icon: IconName) => (
    <Link
      href={href(scope)}
      className={`zone-chip ${styles.chip}${zones === scope ? ' is-active' : ''}`}
      data-zone-filter={scope}
      aria-current={zones === scope ? 'true' : undefined}
      // `replace` rather than `push`: switching scope is refining one search,
      // not starting another, so the back button should return to whatever the
      // reader was doing before the search, not walk them through every scope
      // they tried.
      replace
    >
      <Icon name={icon} />{label}
    </Link>
  );

  return (
    <div className="zone-chips" role="group" aria-label="Result scope">
      {chip('all', 'All', 'grid')}
      {chip('jubilee', 'Jubilee only', 'star')}
    </div>
  );
}
