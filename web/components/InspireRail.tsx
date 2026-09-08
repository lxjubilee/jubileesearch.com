'use client';

// The JubileeInspire rail, ported from js/inspire-rail.js.
//
// Desktop (>1024px): the NAVIGATION row and the collapse arrow toggle between
// 52px of icons and 280px of icons plus labels, remembered per browser.
// Mobile (<=1024px): an off-canvas drawer, opened by the fixed hamburger and
// closed by the backdrop, Escape, or the NAVIGATION row.
//
// A drawer never starts open, and the remembered desktop state is read after
// mount rather than during render — reading localStorage while rendering would
// make the server's HTML and the client's first render disagree.

import { useCallback, useEffect, useState } from 'react';
import { RAIL_ITEMS, RAIL_VIEWBOX } from './rail-items';

const STORAGE_KEY = 'jir-open';
const MOBILE = '(max-width: 1024px)';

export default function InspireRail() {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(MOBILE);

    const apply = () => {
      setIsMobile(query.matches);
      // Desktop restores what the reader chose last time; mobile always starts
      // closed, because a drawer covering the page on arrival is not navigation.
      if (query.matches) {
        setOpen(false);
      } else {
        try { setOpen(localStorage.getItem(STORAGE_KEY) === '1'); } catch { setOpen(false); }
      }
    };

    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  const set = useCallback((next: boolean) => {
    setOpen(next);
    if (!window.matchMedia(MOBILE).matches) {
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') set(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, set]);

  return (
    <>
      <button
        type="button"
        className={`jir-burger${open && isMobile ? ' is-hidden' : ''}`}
        aria-label="Open JubileeInspire navigation"
        onClick={() => set(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
        </svg>
      </button>

      <div className="jir-backdrop" hidden={!(open && isMobile)} onClick={() => set(false)} />

      <nav className={`jir jir-rail${open ? ' is-open' : ''}`} aria-label="JubileeInspire">
        <button
          type="button"
          className="jir-collapse"
          title="Collapse"
          aria-label="Collapse navigation"
          onClick={() => set(false)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          type="button"
          className="jir-item is-head"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => set(!open)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
          </svg>
          <span className="jir-label">NAVIGATION</span>
        </button>

        {RAIL_ITEMS.map((item) => (
          <a
            key={item.label}
            className={`jir-item${item.active ? ' is-active' : ''}`}
            href={item.href}
            data-tip={item.label}
            title={item.label}
            rel={item.href.startsWith('http') ? 'noopener' : undefined}
            aria-current={item.active ? 'page' : undefined}
          >
            <svg viewBox={item.viewBox ?? RAIL_VIEWBOX} aria-hidden="true">
              <path d={item.path} />
            </svg>
            <span className="jir-label">{item.label}</span>
          </a>
        ))}

        <div className="jir-spacer" />

        <a className="jir-brand" href="https://www.jubileeinspire.com/" tabIndex={-1} rel="noopener">
          <div className="jir-brand-text">
            Jubilee<span className="jir-brand-accent">Inspire</span>
            <span className="jir-brand-tld">.com</span>
          </div>
        </a>
        <a className="jir-avatar" href="https://www.jubileeinspire.com/"
           title="JubileeInspire.com" rel="noopener">
          {/* Deliberately a plain <img>: this is the rail's own chrome, not a
              result, and next/image would add a loader round trip for a 36px
              mark that is already in the page's critical path. */}
          <img src="/images/personas/jubilee.png" alt="JubileeInspire" width={36} height={36} />
        </a>
      </nav>
    </>
  );
}
