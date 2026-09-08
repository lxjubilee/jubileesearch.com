import Link from 'next/link';
import SearchBox from '@/components/SearchBox';

export default function NotFound() {
  return (
    <div className="results-container">
      <header className="results-header">
        <div className="results-header-inner">
          <Link href="/" className="results-logo">
            Jubilee<span className="highlight">Search</span>
          </Link>
          <SearchBox variant="results" />
        </div>
      </header>
      <main className="results-list">
        <div className="no-results">
          <p>That page is not here.</p>
          <p>Search for what you were after, or <Link href="/">start again</Link>.</p>
        </div>
      </main>
    </div>
  );
}
