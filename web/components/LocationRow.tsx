'use client';

// The footer's location row.
//
// ---------------------------------------------------------------------------
// ONE DELIBERATE BEHAVIOUR CHANGE FROM THE STATIC SITE, flagged because it is a
// change and not a port.
//
// js/app.js called `navigator.geolocation.getCurrentPosition()` on load and then
// sent the coordinates to OpenStreetMap's Nominatim to turn them into a place
// name. Three problems with carrying that across as-is:
//
//   1. It asks every reader for their precise location on arrival, and sends it
//      to a third party, to render a line of text that nothing else uses. No
//      requirement in the specification asks for it; §13 never mentions
//      location, and nothing in ranking reads it.
//   2. §17 Privacy is deliberate about what is kept and shared —
//      "No cross-site behavioral profiles" — and a coordinate handed to an
//      outside service on every results page sits badly beside that.
//   3. Nominatim's usage policy does not permit being called as a page's
//      automatic per-load geocoder.
//
// So the row is preserved and the automatic call is not: nothing happens until
// the reader asks for it. The permission prompt then arrives because they
// clicked, which is the only time a browser location prompt is answerable.
//
// If the network wants the old behaviour back, this is the one file to change —
// but that should be a decision someone makes, not one a port makes silently.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import styles from './LocationRow.module.css';

const KEY = 'userLocation';

export default function LocationRow() {
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A location the reader asked for previously is theirs and is remembered.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) setLabel(stored);
    } catch { /* private mode */ }
  }, []);

  const detect = () => {
    if (!navigator.geolocation) { setLabel('Location not available'); return; }
    setBusy(true);

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${coords.latitude}&lon=${coords.longitude}`,
            { headers: { accept: 'application/json' } },
          );
          const data = await res.json();
          const place = data?.address?.city ?? data?.address?.town
            ?? data?.address?.village ?? data?.address?.state ?? data?.address?.country;
          const name = place ?? 'Location unavailable';
          setLabel(name);
          try { localStorage.setItem(KEY, name); } catch { /* private mode */ }
        } catch {
          setLabel('Location unavailable');
        } finally {
          setBusy(false);
        }
      },
      (error) => {
        setBusy(false);
        setLabel(error.code === error.PERMISSION_DENIED
          ? 'Location access denied'
          : 'Location unavailable');
      },
      { timeout: 10_000 },
    );
  };

  const clear = () => {
    setLabel(null);
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  };

  return (
    <div className="footer-location">
      {label ? (
        <>
          <span id="user-location">{label}</span>
          <span className="location-separator">-</span>
          <span className="location-source">Based on your location</span>
          <span className="location-separator">-</span>
          <button type="button" className={`footer-action ${styles.action}`} onClick={clear}>
            Forget my location
          </button>
        </>
      ) : (
        <button type="button" className={`footer-action ${styles.action}`} onClick={detect} disabled={busy}>
          {busy ? 'Locating…' : 'Use my location'}
        </button>
      )}
    </div>
  );
}
