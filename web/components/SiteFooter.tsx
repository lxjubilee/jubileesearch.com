import LocationRow from './LocationRow';

// The results footer, ported from search.html.

export default function SiteFooter() {
  return (
    <footer className="results-footer">
      <LocationRow />
      <div className="footer-links-row">
        <a href="https://jubileeenterprise.com/help" className="footer-link">Help</a>
        <span className="footer-separator">|</span>
        <a href="https://jubileeenterprise.com/feedback" className="footer-link">Send feedback</a>
        <span className="footer-separator">|</span>
        <a href="https://jubileeenterprise.com/terms" className="footer-link">Terms of Use</a>
        <span className="footer-separator">|</span>
        <a href="https://jubileeenterprise.com/privacy" className="footer-link">Privacy</a>
      </div>
    </footer>
  );
}
