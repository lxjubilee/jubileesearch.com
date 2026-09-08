import type { Metadata } from 'next';
import SearchBox from '@/components/SearchBox';

// The home page. A server component: it holds no state, and the only
// interactive part is the search box, which is a client component of its own.
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
            <a href="https://jubileeenterprise.com/privacy">Privacy Policy</a>&nbsp;|&nbsp;
            <a href="https://jubileeenterprise.com/terms">Terms of Use</a>
          </div>
        </SearchBox>
      </div>
    </div>
  );
}
