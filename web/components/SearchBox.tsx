'use client';

// The search box, on both the home page and the results header.
//
// It is a real `<form method="GET" action="/search">`. That is deliberate: with
// JavaScript disabled, or before hydration on a slow connection, typing a query
// and pressing Enter still works, because the browser does what forms do. The
// suggestion dropdown is an enhancement layered on top of that, not the
// mechanism.
//
// The static site had suggestion code in js/app.js and no `#suggestions`
// element in either page, so `renderSuggestions` bailed on every keystroke and
// the feature never ran. The engine's /api/v1/suggest has always worked; this
// is it wired up.

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SuggestResponse } from '@/lib/types';
import styles from './SearchBox.module.css';

const DEBOUNCE_MS = 140;
const MIN_CHARS = 2;

interface Props {
  initialQuery?: string;
  variant?: 'home' | 'results';
  autoFocus?: boolean;
  /** Rendered inside the wrapper, beneath the form -- the home page's
   *  disclaimer sits there in the original markup and the CSS expects it. */
  children?: React.ReactNode;
}

export default function SearchBox({
  initialQuery = '', variant = 'home', autoFocus, children,
}: Props) {
  const router = useRouter();
  const listId = useId();

  const [query, setQuery] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selected, setSelected] = useState(-1);
  const [open, setOpen] = useState(false);
  // Suggestions are an answer to typing. Seeding the field from the URL on the
  // results page is not typing, and a dropdown covering the results on arrival
  // is not a suggestion.
  const [typed, setTyped] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Survives re-renders; used to discard a response that arrived after a newer
  // keystroke already went out.
  const latestRequest = useRef(0);

  // Keep the field in step when the URL changes underneath us -- clicking a
  // "Jubilee only" chip is a navigation, and the box must not keep showing the
  // previous query.
  useEffect(() => { setQuery(initialQuery); setTyped(false); }, [initialQuery]);

  useEffect(() => {
    if (!typed || query.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const ticket = ++latestRequest.current;

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/suggest?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as SuggestResponse;
        // Out-of-order responses are the classic typeahead bug: a slow request
        // for "sh" landing after a fast one for "shabbat" repopulates the list
        // with the wrong suggestions.
        if (ticket !== latestRequest.current) return;
        setSuggestions(data.suggestions ?? []);
        setSelected(-1);
        setOpen((data.suggestions ?? []).length > 0);
      } catch {
        // An aborted or failed suggest is not worth telling the reader about.
        // They are typing; the results page is one Enter away.
      }
    }, DEBOUNCE_MS);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, typed]);

  useEffect(() => {
    const onClickAway = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClickAway);
    return () => document.removeEventListener('click', onClickAway);
  }, []);

  const submit = (value: string) => {
    const q = value.trim();
    if (!q) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Escape') setOpen(false);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let next = selected + step;
        if (next < -1) next = suggestions.length - 1;
        if (next >= suggestions.length) next = -1;
        setSelected(next);
        // -1 is "back to what I typed", which is why the original query is not
        // overwritten as the reader arrows through.
        setQuery(next >= 0 ? suggestions[next]! : initialQuery || query);
        break;
      }
      case 'Enter':
        if (selected >= 0) {
          e.preventDefault();
          submit(suggestions[selected]!);
        }
        break;
      case 'Escape':
        setOpen(false);
        setSelected(-1);
        break;
      default:
        break;
    }
  };

  const wrapperClass = [
    variant === 'results' ? 'results-search-box search-wrapper' : 'search-wrapper',
    styles.anchor,
  ].join(' ');

  return (
    <div className={wrapperClass} ref={boxRef}>
      <form
        action="/search"
        method="GET"
        onSubmit={(e) => { e.preventDefault(); submit(query); }}
        role="search"
      >
        <div className="search-box">
          <input
            ref={inputRef}
            type="text"
            name="q"
            className="search-input"
            placeholder="Search"
            autoComplete="off"
            autoFocus={autoFocus}
            value={query}
            onChange={(e) => { setTyped(true); setQuery(e.target.value); }}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(typed && suggestions.length > 0)}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined}
          />
          <div className="search-actions">
            <button type="submit" className="voice-button" title="Search" aria-label="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>
          </div>
        </div>
      </form>

      {open && suggestions.length > 0 && (
        <ul className={styles.suggestions} id={listId} role="listbox" aria-label="Suggestions">
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === selected}
              className={`${styles.item}${index === selected ? ` ${styles.selected}` : ''}`}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}   // keep focus for the click
              onClick={() => submit(suggestion)}
            >
              <span className={styles.icon} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              </span>
              <span className={styles.text}>{suggestion}</span>
            </li>
          ))}
        </ul>
      )}

      {children}
    </div>
  );
}
