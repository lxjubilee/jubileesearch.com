import Link from 'next/link';
import LocationRow from './LocationRow';

// The results footer, ported from search.html.

export default function SiteFooter() {
  return (
    <footer className="results-footer">
      <LocationRow />
      <div className="footer-links-row">
        {/* Local: the Help page that used to be linked on another Jubilee
            property never existed there. Send feedback went with it -- the
            report control on each result and /suggest are the feedback paths. */}
        <Link href="/help" className="footer-link">Help</Link>
        <span className="footer-separator">|</span>
        {/* Local now: §17 Legal requires a search-specific privacy notice, and the
            terms describe this service rather than the network. */}
        <Link href="/terms" className="footer-link">Terms of Use</Link>
        <span className="footer-separator">|</span>
        <Link href="/privacy" className="footer-link">Privacy</Link>
      </div>
    </footer>
  );
}
