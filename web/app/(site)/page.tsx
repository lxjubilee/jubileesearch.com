import type { Metadata } from 'next';
import Link from 'next/link';
import SearchBox from '@/components/SearchBox';
import AccountCorner from '@/components/AccountCorner';

// The home page. A server component: the only interactive part is the search
// box, which is a client component of its own.
//
// It holds no state itself, but AccountCorner reads the session cookie, so the
// route renders per request rather than once at build. See that component for
// why that trade is worth making.
//
// The markup and class names are the static site's, unchanged. The vertical
// rhythm — 140px avatar, 88px wordmark, 760px composer — was copied box for box
// from JubileeInspire's chat welcome state so the two land at the same height,
// and it lives in globals.css.

export const metadata: Metadata = {
  title: 'JubileeSearch',
  description:
    'Search the Jubilee network and a family-safe window on the wider web.',
};

export default function HomePage() {
  return (
    <div className="home-container">
      {/* Out of flow, so the centred stack below is untouched by it. */}
      <AccountCorner />

      <div className="welcome-state">
        <div className="avatar-container">
          <div className="avatar-wrapper">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/personas/jubilee.png" alt="Jubilee" className="avatar-image" />
          </div>
        </div>

        <div className="logo-container">
          <h1 className="main-logo">
            Jubilee<span className="highlight">Search</span>
            <span className="dotcom">.com</span>
          </h1>
        </div>

        <SearchBox autoFocus>
          <div className="search-copyright">
            Copyright &copy; 2026 JubileeSearch.com | All Rights Reserved.
            Jubilee and AI can make mistakes.&nbsp;|&nbsp;
            <Link href="/privacy">Privacy Policy</Link>&nbsp;|&nbsp;
            <Link href="/terms">Terms of Use</Link>
          </div>
        </SearchBox>
      </div>
    </div>
  );
}
