import type { Metadata } from 'next';
import styles from './bot.module.css';

// The public bot information page (§9.4).
//
// "A public bot information page at that URL must exist before the first
// external crawl, explaining what the crawler does and how to block it."
//
// The URL is fixed by the user agent the fetcher sends and cannot be changed
// without changing that string:
//   JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)
//
// It is the one page on this site that should be indexed by other engines --
// see the header exception in next.config.ts. A webmaster looking up a crawler
// that has been hitting their server has to be able to find it.

export const metadata: Metadata = {
  title: 'JubileeSearchBot',
  description: 'What the JubileeSearch crawler does, and how to keep it off your site.',
  robots: { index: true, follow: true },
};

const CONTACT = process.env.BOT_CONTACT_EMAIL ?? '';

export default function BotPage() {
  return (
    <main className={styles.page}>
      <h1>Jubilee<span>SearchBot</span></h1>
      <p className={styles.lede}>
        You are probably here because you found this line in a server log.
        Here is what it is and how to stop it.
      </p>

      <pre><code className={styles.ua}>JubileeSearchBot/1.0 (+https://jubileesearch.com/bot)</code></pre>

      <h2>What it does</h2>
      <p>
        JubileeSearchBot builds the index behind{' '}
        <a href="https://www.jubileesearch.com/">JubileeSearch.com</a>, a search engine for
        faith-based content run by Jubilee Software, Inc. It reads the text of public web
        pages so that they can be found by search, and stores that text only to build the
        index and to show a short extract alongside a link back to your page.
      </p>

      <h2>What it does not do</h2>
      <ul>
        <li>
          <strong>It never downloads images.</strong> No pictures, thumbnails, or media files
          are fetched, stored, or displayed. Result cards are text only.
        </li>
        <li>It does not submit forms, click buttons, or attempt to reach anything behind a login.</li>
        <li>It does not republish your pages. Results link to your site.</li>
        <li>It does not sell placement. There is no advertising in the results.</li>
      </ul>

      <h2>How it behaves</h2>
      <ul>
        <li>It reads and obeys <code>robots.txt</code>, including <code>Crawl-delay</code>.</li>
        <li>
          It obeys <code>X-Robots-Tag</code> headers and{' '}
          <code>&lt;meta name=&quot;robots&quot;&gt;</code> tags.
        </li>
        <li>
          It sends <code>If-None-Match</code> and <code>If-Modified-Since</code>, so a page that
          has not changed costs your server one small <code>304</code> and nothing else.
        </li>
        <li>It visits one page at a time per host, with a delay between requests.</li>
        <li>
          It backs off on <code>429</code> and <code>5xx</code> responses, and stops entirely
          after repeated failures.
        </li>
        <li>It stops at 5 MB per response and skips anything that is not HTML, plain text, or PDF.</li>
      </ul>

      <h2>How to block it</h2>
      <p>Add this to your <code>robots.txt</code>. It takes effect on the next visit.</p>
      <pre><code>{`User-agent: JubileeSearchBot\nDisallow: /`}</code></pre>
      <p>To allow the rest of your site but keep one section out:</p>
      <pre><code>{`User-agent: JubileeSearchBot\nDisallow: /members/\nDisallow: /drafts/`}</code></pre>

      <h2>How to get a page removed</h2>
      <p>
        Write to us and we will remove it. We answer removal requests within five business days.
        Include the URL, and say whether you want the single page removed or the whole site.
        You do not need to give a reason.
      </p>

      {CONTACT ? (
        <p><a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
      ) : (
        <p className={styles.todo}>
          <strong>Before this page goes live:</strong> there is no contact address configured.
          Decision <strong>D7</strong> in the specification &mdash; the bot contact email for
          this page and for removal requests &mdash; has not been made, and it is needed before
          the first external crawl. Set <code>BOT_CONTACT_EMAIL</code> in the web app&apos;s
          environment and it will appear here.
        </p>
      )}

      <h2>If it is behaving badly</h2>
      <p>
        Tell us. Requesting too fast, ignoring a rule in your <code>robots.txt</code>, or fetching
        something it should not &mdash; any of those is a bug on our side, and we would rather
        hear about it than have you block us and move on.
      </p>

      <footer>
        JubileeSearchBot is operated by Jubilee Software, Inc.
        &middot; <a href="https://www.jubileesearch.com/">JubileeSearch.com</a>
        &middot; <a href="/privacy">Search privacy notice</a>
      </footer>
    </main>
  );
}
