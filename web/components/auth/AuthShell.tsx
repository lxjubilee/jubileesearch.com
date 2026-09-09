'use client';

/* ─────────────────────────────────────────────────────────────────────────
   The frame every auth screen sits in.

   Left: the wordmark and whatever the screen is. Right: the drifting bubbles
   and the rotating scripture. Ported from kJubilee.com's app/_auth-shell.js.

   One difference, in the backdrop. kJubilee cross-fades four photographs from
   images.unsplash.com. Loading them here would hand Unsplash the IP address of
   every reader who opens this page, and /privacy enumerates exactly who sees
   anything — so it would have made that notice incomplete on the day it
   shipped. The slides are gradients instead: the same four-up cross-fade, the
   same overlay, bubbles and scripture, sourced from nobody.

   To use real photographs, put them in public/images/auth/ and replace the
   BACKDROPS entries with `url('/images/auth/....jpg')`. Self-hosted, they cost
   no third party anything and this note stops applying.
   ───────────────────────────────────────────────────────────────────────── */

import { useState, useEffect } from 'react';

const BACKDROPS = [
  'radial-gradient(120% 90% at 20% 15%, #123a63 0%, #0b1d33 55%, #060d18 100%)',
  'radial-gradient(120% 90% at 80% 20%, #14324f 0%, #0a2237 55%, #05101c 100%)',
  'radial-gradient(120% 90% at 35% 80%, #1a3f5c 0%, #0d2438 55%, #060e19 100%)',
  'radial-gradient(120% 90% at 70% 70%, #0f3350 0%, #0a1e30 55%, #050b14 100%)',
];

const QUOTES = [
  { text: '"Ask and it will be given to you; seek and you will find; knock and the door will be opened to you."', cite: '— Matthew 7:7' },
  { text: '"Your word is a lamp for my feet, a light on my path."', cite: '— Psalm 119:105' },
  { text: '"Trust in the Lord with all your heart and lean not on your own understanding; in all your ways submit to him, and he will make your paths straight."', cite: '— Proverbs 3:5-6' },
  { text: '"Then you will know the truth, and the truth will set you free."', cite: '— John 8:32' },
  { text: '"For I know the plans I have for you," declares the Lord, "plans to prosper you and not to harm you, plans to give you hope and a future."', cite: '— Jeremiah 29:11' },
];

function BackdropPanel() {
  const [slide, setSlide] = useState(0);
  const [quote, setQuote] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setSlide((i) => (i + 1) % BACKDROPS.length), 5000);
    return () => clearInterval(t);
  }, []);

  // Fade the words out, swap them, fade back in — the same two-step kJubilee
  // does with a 500ms timeout.
  useEffect(() => {
    const t = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setQuote((i) => (i + 1) % QUOTES.length);
        setFading(false);
      }, 500);
    }, 8000);
    return () => clearInterval(t);
  }, []);

  // QUOTES is a non-empty literal and `quote` is always modulo its length, but
  // noUncheckedIndexedAccess cannot know that.
  const current = QUOTES[quote] ?? QUOTES[0]!;

  return (
    <div className="auth-bg-panel" aria-hidden="true">
      {BACKDROPS.map((bg, i) => (
        <div
          key={bg}
          className={`bg-slide${i === slide ? ' active' : ''}`}
          style={{ backgroundImage: bg }}
        />
      ))}
      <div className="bg-overlay" />
      <ul className="bubbles">
        {Array.from({ length: 10 }, (_, i) => <li key={i} />)}
      </ul>
      <div className="scripture-quote" style={{ opacity: fading ? 0 : 1 }}>
        <span>{current.text}</span>
        <cite>{current.cite}</cite>
      </div>
    </div>
  );
}

export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="wave-bar" />

      <div className="auth-row">
        <div className="auth-form-panel">
          <div className="auth-form-inner">
            <div className="auth-logo">
              <a href="/" aria-label="JubileeSearch.com home">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/personas/jubilee.png"
                  alt=""
                  className="auth-logo-img"
                  width="92"
                  height="92"
                />
                <span className="auth-logo-text">
                  Jubilee<span className="search">Search</span><span className="dotcom">.com</span>
                </span>
              </a>
            </div>

            {children}
          </div>

          <div className="auth-footer">
            <p className="copyright">
              Copyright &copy; {new Date().getFullYear()} Jubilee Software, Inc. All rights reserved.{' '}
              <a href="/terms">Terms of Use</a> ·{' '}
              <a href="/privacy">Privacy Policy</a>
            </p>
          </div>
        </div>

        <BackdropPanel />
      </div>
    </>
  );
}
