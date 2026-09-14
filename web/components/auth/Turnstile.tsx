'use client';

/* ─────────────────────────────────────────────────────────────────────────
   The Cloudflare Turnstile challenge, as one component.

   Ported from kJubilee.com's app/_turnstile.js. Three unobvious things it
   carries, all of which were arrived at the hard way there:

     1. The widget is a fixed 300px iframe. Rendered as-is it sits narrow beside
        a full-width email field, so the wrapper is measured and the widget CSS-
        scaled to it. The rest of the family reached the same fix after trying
        size:'flexible'.

     2. A token is SINGLE USE. Cloudflare rejects a replay, so any submit that
        does not navigate away has to reset the widget before the next attempt —
        hence `resetNonce`.

     3. The widget only paints on a hostname in the site key's Cloudflare
        allowlist. When it cannot, onUnavailable fires: the caller decides what
        that means, because the answer differs between "let them through" and
        "the server is going to refuse anyway".
   ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useCallback } from 'react';
import Script from 'next/script';

const WIDGET_W = 300;
const WIDGET_H = 65;

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

export default function Turnstile(
  { siteKey, onToken, onUnavailable, resetNonce = 0 }: {
    siteKey: string;
    onToken?: (token: string) => void;
    onUnavailable?: () => void;
    resetNonce?: number;
  },
) {
  const boxRef = useRef<HTMLDivElement>(null);    // full-width wrapper, measured
  const innerRef = useRef<HTMLDivElement>(null);  // the 300px widget, scaled into it
  const widgetId = useRef<string | null>(null);

  // The callbacks are held in a ref so re-rendering the parent — which happens
  // on every keystroke in the email field — never re-renders the widget.
  const handlers = useRef({ onToken, onUnavailable });
  handlers.current = { onToken, onUnavailable };

  const render = useCallback(() => {
    if (!siteKey || !innerRef.current || !window.turnstile || widgetId.current) return;
    widgetId.current = window.turnstile.render(innerRef.current, {
      sitekey: siteKey,
      theme: 'dark',
      size: 'normal',
      callback: (t: string) => handlers.current.onToken?.(t),
      // Cloudflare hands the reason in as a code. Logged rather than swallowed:
      // "the widget did not load" has several very different causes — an
      // unlisted hostname (110200) is a dashboard fix, a network failure is not —
      // and without the code they are indistinguishable from the outside.
      'error-callback': (code: string) => {
        console.error('[turnstile] widget error', code);
        handlers.current.onUnavailable?.();
        return true;
      },
      'expired-callback': () => handlers.current.onToken?.(''),
    });
  }, [siteKey]);

  // Cloudflare's script may already be loaded from an earlier visit to this
  // page, in which case Script's onLoad never fires again.
  useEffect(() => {
    render();
    return () => {
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* already gone */ }
      }
      widgetId.current = null;
    };
  }, [render]);

  useEffect(() => {
    if (!resetNonce) return;
    if (widgetId.current && window.turnstile) {
      try { window.turnstile.reset(widgetId.current); } catch { /* already gone */ }
    }
  }, [resetNonce]);

  useEffect(() => {
    if (!siteKey) return undefined;
    const box = boxRef.current, inner = innerRef.current;
    if (!box || !inner) return undefined;
    const apply = () => {
      const scale = box.clientWidth / WIDGET_W;
      inner.style.transform = `scale(${scale})`;
      box.style.height = `${WIDGET_H * scale}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    return () => ro.disconnect();
  }, [siteKey]);

  if (!siteKey) return null;

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onLoad={render}
        onError={() => handlers.current.onUnavailable?.()}
      />
      <div className="door-turnstile" ref={boxRef}>
        <div className="door-turnstile-inner" ref={innerRef} />
      </div>
    </>
  );
}
