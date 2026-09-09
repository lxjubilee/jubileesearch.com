import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './suggest.module.css';

// The content-request page (§13.5, §10.3).
//
// Zone A's empty state says: "The Jubilee network has not covered this one yet.
// Tell us what you were looking for and we will pass it to the writing team."
// That link pointed at a page that did not exist, so the single invitation the
// engine extends to a reader ended in a 404.
//
// The page is deliberately small. Someone arrives here from a search that
// failed them, and a long form is a poor apology. One optional box, and an
// honest account of what happens to it.
//
// P7 note: nothing submitted here is ever published, quoted, or shown to another
// reader. It is an inbox for the writing team. A request is not an article.

export const metadata: Metadata = {
  title: 'Tell us what you were looking for',
  description: 'Ask the Jubilee writing team to cover something the network has not covered yet.',
  robots: { index: false, follow: false },
};

export default async function SuggestPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

  const q = one(params.q).slice(0, 500);
  const lang = one(params.lang).slice(0, 16);
  const sent = one(params.sent) === '1';
  const error = one(params.error);

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>JubileeSearch</p>
      <h1 className={styles.title}>
        Tell us what you were <span>looking for</span>
      </h1>

      {sent && (
        <div className={`${styles.notice} ${styles.sent}`}>
          <strong>Thank you — that has been passed to the writing team.</strong>{' '}
          We do not send a reply, because we did not ask who you are. If something
          gets written, it will simply start appearing in searches.
        </div>
      )}

      {error === 'engine' && (
        <div className={`${styles.notice} ${styles.failed}`}>
          <strong>That did not send.</strong> The search service is not answering
          right now, and rather than show you a thank-you it has not earned, this
          page is telling you plainly. Please try again shortly.
        </div>
      )}

      {error === 'missing' && (
        <div className={`${styles.notice} ${styles.failed}`}>
          <strong>Nothing was sent.</strong> The request had no search attached to
          it, so there was nothing for the writing team to act on.
        </div>
      )}

      {!sent && (
        <>
          <p className={styles.lead}>
            When the Jubilee network has not covered something, we would rather
            hear it from you than guess. Searches that come back empty are already
            counted — but a sentence in your own words is worth far more to a
            writer than the words you happened to type into the box.
          </p>

          {q && (
            <div className={styles.echo}>
              <span className={styles.echoLabel}>Your search</span>
              <span className={styles.echoQuery}>{q}</span>
            </div>
          )}

          {/* A real form POST: this works with JavaScript disabled and before
              hydration, same as the search box. */}
          <form className={styles.form} action="/api/suggest" method="POST">
            <input type="hidden" name="q" value={q} />
            <input type="hidden" name="lang" value={lang} />

            <label className={styles.label} htmlFor="note">
              What were you hoping to find?
            </label>
            <p className={styles.hint}>
              Optional. Anything helps — who it is for, what you already tried,
              what would have answered your question.
            </p>
            <textarea
              id="note"
              name="note"
              className={styles.textarea}
              maxLength={4000}
              placeholder="I was looking for somewhere to start reading the Bible as an adult…"
            />

            <div className={styles.actions}>
              <button type="submit" className={styles.submit}>Send to the writing team</button>
              <Link href={q ? `/search?q=${encodeURIComponent(q)}` : '/'} className={styles.cancel}>
                Back to results
              </Link>
            </div>
          </form>
        </>
      )}

      <p className={styles.privacy}>
        <strong>This is not signed.</strong> Your search and what you write here
        are stored on their own, with no Jubilee ID, no session and no IP address
        attached — so a request can never be traced back to the person who made
        it, and we cannot reply to you. That is a deliberate trade, and the{' '}
        <Link href="/privacy">privacy notice</Link> explains it.
      </p>

      <nav className={styles.footerNav}>
        <Link href="/">Search</Link>
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/terms">Terms of use</Link>
      </nav>
    </main>
  );
}
