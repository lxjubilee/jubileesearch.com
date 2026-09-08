'use client';

// Zone B's shell and its collapse toggle.
//
// §13.5, user controls: "a Zone B collapse toggle whose state persists per
// session". Session, not local — the preference is about this visit, and a
// reader who hid the wider web once should not find it hidden next week without
// remembering why.
//
// The children are server-rendered and passed through, so the results are in the
// HTML whatever this component does. Collapsing hides them; it never removes
// them from the document, which keeps the ordering guarantee intact and keeps
// the block one click from coming back.

import { useEffect, useState } from 'react';

const KEY = 'jubilee.zoneB.collapsed';

export default function ZoneBCollapse({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  // Always starts expanded, matching the server's HTML and §13.5's stated
  // default. Reading sessionStorage during render would make the first client
  // render disagree with the server's and React would discard the markup.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { setCollapsed(sessionStorage.getItem(KEY) === 'true'); } catch { /* private mode */ }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { sessionStorage.setItem(KEY, String(next)); } catch { /* private mode */ }
  };

  return (
    <section
      className={`zone zone-b${collapsed ? ' is-collapsed' : ''}`}
      aria-labelledby="zone-b-heading"
    >
      <div className="zone-heading-row">
        <h2 id="zone-b-heading" className="zone-heading">{label}</h2>
        <button
          type="button"
          className="zone-toggle"
          data-zone-toggle
          aria-expanded={!collapsed}
          aria-controls="zone-b-results"
          onClick={toggle}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {/* Acceptance criterion 14. §11.4 makes this label the mechanism by which
          doctrinal judgement stays a human editorial decision rather than an
          automated classifier: the boundary between "ours" and "not ours" is
          visible to the reader instead of buried in a ranking function. */}
      <p className="zone-note">
        These come from outside the Jubilee network and are not Jubilee-endorsed.
      </p>

      <div hidden={collapsed}>{children}</div>
    </section>
  );
}
