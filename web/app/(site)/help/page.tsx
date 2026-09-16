import type { Metadata } from 'next';
import Link from 'next/link';
import { legalIdentity } from '@/lib/legal';
import styles from '../legal.module.css';

// Help.
//
// The results footer linked to a Help page on another Jubilee property that did
// not exist, so the link was a dead end. This is the page it now points at:
// the questions a reader actually has about a search engine that is not
// Google -- what is in it, what "From Jubilee" and "From the wider web" mean,
// why something is missing, what signing in changes, how to report a result --
// answered from what the service actually does rather than in help-desk prose.
//
// Same frame as the privacy and terms pages so the three read as one set. The
// contact address, like theirs, is configuration (lib/legal.ts): an invented
// mailbox would be worse than none.

export const metadata: Metadata = {
  title: 'Help',
  description: 'How JubileeSearch works, what the two result zones are, and how to report a result or ask for a topic.',
};

export default function HelpPage() {
  const identity = legalIdentity();

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>JubileeSearch</p>
      <h1 className={styles.title}>Help</h1>

      <p className={styles.lead}>
        JubileeSearch finds pages across the Jubilee network and a family-safe selection of
        the wider web, and links you to them. Here is what to expect from it and what to do
        when something is not right.
      </p>

      <Section n="1" title="Searching">
        <p>
          Type what you are looking for and press Enter or the search button. Plain words
          work best: <em>psalm about fear</em>, <em>who was Boaz</em>, <em>feeling far from
          God</em>. You do not need quotation marks or special operators.
        </p>
        <p>
          As you type, suggestions appear beneath the box. Use the arrow keys to move through
          them and Enter to search for one, or keep typing and ignore them. The × inside the
          box clears it.
        </p>
      </Section>

      <Section n="2" title="The two groups of results">
        <p>
          <b>From Jubilee</b> comes first. These are pages from the Jubilee family of sites:
          articles, messages, Bible talks, music and prayers written and published by the
          network itself.
        </p>
        <p>
          <b>From the wider web</b> follows. These pages come from outside the network. They
          have passed a family-safety check, but they are not written, reviewed or endorsed by
          Jubilee, and the section says so above them. You can hide that section with the
          <b> Hide</b> control, and the choice is remembered for the rest of your visit.
        </p>
        <p>
          The <b>Jubilee only</b> chip under the result count limits a search to the network.
          <b> All results</b> brings the wider web back.
        </p>
      </Section>

      <Section n="3" title="What the text under each result is">
        <p>
          Every result shows the site, the address and a short passage quoted from the page
          itself. Nothing is generated or summarised: the passage is the page&rsquo;s own
          words, chosen because they match what you searched for. Names and words from your
          search are shown in bold.
        </p>
        <p>
          Some results carry a <b>Continue this thread</b> line with related pages from the
          same site, and some searches open with a scripture card or a short panel about a
          person or place. Those come from the network&rsquo;s own pages too.
        </p>
      </Section>

      <Section n="4" title="When nothing, or the wrong thing, comes up">
        <p>
          If the network has not covered a topic yet, the results say so and offer a link,{' '}
          <Link href="/suggest">Tell us what you were looking for</Link>. Anything you send
          there goes to the writing team. It is stored without your name, address or account,
          so it cannot be traced back to you.
        </p>
        <p>
          Try fewer words, or different ones. A search for a whole sentence matches less than
          a search for the two or three words that matter in it.
        </p>
      </Section>

      <Section n="5" title="Reporting a result">
        <p>
          Under every result is <b>Report this result</b>. Use it for a broken link, a page
          that is not about what it appears to be, or content that should not be shown. A
          short reason is enough. Reports go to the people who maintain the index, who check
          the page against the family-safety rules. The page does not tell you whether a
          result has been reported before or what was decided; that is deliberate.
        </p>
      </Section>

      <Section n="6" title="Signing in">
        <p>
          Searching never requires an account. Signing in with a Jubilee ID, the same
          sign-in used across the Jubilee sites, raises your search limit and lets the
          network learn from which results people who are signed in find useful. What is
          kept, and for how long, is set out in the <Link href="/privacy">privacy notice</Link>.
        </p>
        <p>
          <b>Keep me signed in on this device</b> keeps you signed in across browser
          restarts until you sign out. Leave it unticked on a shared computer and the
          sign-in ends when the browser closes. You can change your name, change your
          password or sign out from your <Link href="/account">account page</Link>.
        </p>
      </Section>

      <Section n="7" title="If you publish a site">
        <p>
          The network&rsquo;s crawler identifies itself and respects the usual robots rules.
          The <Link href="/bot">crawler page</Link> explains how it announces itself, how to
          slow it down or keep it out, and how to have a page removed from the results.
        </p>
      </Section>

      <Section n="8" title="Contact">
        {identity.contact ? (
          <p>
            For anything this page does not answer, write to{' '}
            <a href={`mailto:${identity.contact}`}>{identity.contact}</a>.
          </p>
        ) : (
          <p>
            For anything this page does not answer, use <b>Report this result</b> on the
            result concerned, or <Link href="/suggest">tell us what you were looking for</Link>.
          </p>
        )}
      </Section>

      <nav className={styles.footerNav}>
        <Link href="/">Search</Link>
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/terms">Terms of use</Link>
        <Link href="/bot">About the crawler</Link>
      </nav>
    </main>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 id={`s${n}`}><em>{n}</em>{title}</h2>
      {children}
    </section>
  );
}
