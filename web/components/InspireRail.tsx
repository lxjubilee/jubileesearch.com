'use client';

// The JubileeInspire rail, ported from js/inspire-rail.js.
//
// Rows: New Chat, then the shared family block JubileeInspire serves to every
// property (useCommonRail.ts), then Jubilee Search — the same order as the rail
// on jubileeinspire.com. Only the first and last are this site's to change.
//
// Desktop (>1024px): the NAVIGATION row and the collapse arrow toggle between
// 52px of icons and 280px of icons plus labels, remembered per browser.
// Mobile (<=1024px): an off-canvas drawer, opened by the fixed hamburger and
// closed by the backdrop, Escape, or the NAVIGATION row.
//
// A drawer never starts open, and the remembered desktop state is read after
// mount rather than during render — reading localStorage while rendering would
// make the server's HTML and the client's first render disagree.

import { useCallback, useEffect, useRef, useState } from 'react';
import { NEW_CHAT, RAIL_VIEWBOX, THIS_HOST, THIS_SITE, type RailItem } from './rail-items';
import { resolveRailIcon } from './rail-icons';
import { useCommonRailItems } from './useCommonRail';

const STORAGE_KEY = 'jir-open';
const MOBILE = '(max-width: 1024px)';

/** Bare registrable host: no scheme, no `www.`, no port, no path. */
function railHost(href: string): string {
  try {
    return new URL(href, 'https://x.invalid').hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function RailRow({ item }: { item: RailItem }) {
  return (
    <a
      className={`jir-item${item.active ? ' is-active' : ''}`}
      href={item.href}
      data-tip={item.label}
      title={item.label}
      rel={item.href.startsWith('http') ? 'noopener' : undefined}
      aria-current={item.active ? 'page' : undefined}
    >
      <svg viewBox={RAIL_VIEWBOX} aria-hidden="true">
        <path d={item.path} />
      </svg>
      <span className="jir-label">{item.label}</span>
    </a>
  );
}

export default function InspireRail() {
  const shared = useCommonRailItems();
  const scrollRef = useRef<HTMLDivElement>(null);

  // The row for this site is the last one, so in a short or zoomed-in window it
  // is the first to fall below the fold of the scrolling rows. Bring it into
  // view — and again when the shared block arrives, because that pushes it
  // further down. The box is scrolled directly rather than with scrollIntoView,
  // which would scroll the page as well.
  // Zooming is a resize, so the same check runs when the window changes size.
  useEffect(() => {
    const reveal = () => {
      const box = scrollRef.current;
      const row = box?.querySelector<HTMLElement>('.jir-item.is-active');
      if (!box || !row) return;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = top + row.offsetHeight - box.clientHeight;
      }
    };
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [shared]);
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

        {/* The rows scroll; the head above and the foot below do not. Like
            JubileeInspire's .menuScroll: when the window is short — or zoomed
            far in — the list scrolls instead of running under the wordmark. */}
        <div className="jir-scroll" ref={scrollRef}>
        <RailRow item={NEW_CHAT} />

        {/* The shared block, from jubileeinspire.com/admin/rail. Renders
            nothing until it arrives, and nothing if it never does. */}
        {shared.map((item) => {
          const { viewBox, path } = resolveRailIcon(item.icon, item.iconViewBox);
          const here = railHost(item.href) === THIS_HOST;
          return (
            <a
              key={item.id}
              className={`jir-item${here ? ' is-active' : ''}`}
              href={here ? '/' : item.href}
              data-tip={item.label}
              title={item.label}
              aria-current={here ? 'page' : undefined}
              {...(item.openInNewTab && !here
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : { rel: 'noopener' })}
            >
              <svg viewBox={viewBox} aria-hidden="true">
                <path d={path} />
              </svg>
              <span className="jir-label">{item.label}</span>
            </a>
          );
        })}

        {/* If the shared list ever carries this site, that row is the one
            marked; a second Jubilee Search row below it would be a duplicate. */}
        {!shared.some((item) => railHost(item.href) === THIS_HOST) && <RailRow item={THIS_SITE} />}

        </div>

        <div className="jir-foot">
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
        </div>
      </nav>
    </>
  );
}
