import type { Metadata } from 'next';
import Link from 'next/link';
import { legalIdentity, missingLegalFacts, ENTITY_FALLBACK } from '@/lib/legal';
import styles from '../legal.module.css';

// Terms of use.
//
// Unlike the privacy notice, the specification does not ask for this page —
// §17 Legal names only "a bot information page and a search privacy notice". So
// the terms are grounded in what the specification *does* commit the service to,
// rather than in boilerplate: Zone B is not endorsed (§11.4), results are quoted
// and never generated (P7), the API is not open to third parties (§2.2), rate
// limits are 60 and 300 a minute (§14), and removal requests are answered within
// five business days (§17).
//
// The clauses a terms document normally leads with — the entity, the governing
// law, the venue — are configuration, for the same reason as on the privacy
// page. Inventing a jurisdiction would be inventing the one clause that decides
// where a dispute is heard.

export const metadata: Metadata = {
  title: 'Terms of use',
  description: 'The terms for using JubileeSearch and its API.',
};

export default function TermsPage() {
  const identity = legalIdentity();
  const missing = missingLegalFacts(identity);
  const entity = identity.entity ?? ENTITY_FALLBACK;

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>JubileeSearch</p>
      <h1 className={styles.title}>Terms of <span>use</span></h1>

      <p className={styles.lead}>
        The terms on which {entity} offers JubileeSearch. They are short because the
        service is narrow: it finds pages and links you to them.
      </p>

      <div className={styles.meta}>
        <span><b>Applies to</b> www.jubileesearch.com and its search API</span>
        {identity.effectiveDate && <span><b>Effective</b> {identity.effectiveDate}</span>}
        {identity.jurisdiction && <span><b>Governed by</b> {identity.jurisdiction}</span>}
      </div>

      <Section n="1" title="What the service is">
        <p>
          JubileeSearch indexes the Jubilee network and a selection of the wider web, and
          returns links with a short quotation from each page. It is a way of finding
          things other people wrote. It is not a publisher of those things and does not
          answer questions of its own.
        </p>
        <p>
          Using it means accepting these terms. You do not need an account; signing in is
          optional and covered in clause 6.
        </p>
      </Section>

      <Section n="2" title="Results from the wider web are not endorsed">
        <p>
          Results are shown in two blocks, and the difference is the point.{' '}
          <strong>From Jubilee</strong> is content the network publishes.{' '}
          <strong>From the wider web</strong> is everything else: pages that passed our
          safety checks, on sites we do not run.
        </p>
        <div className={styles.pledge}>
          <p>
            Appearing in the wider-web block is not a recommendation, an endorsement, or
            a statement that a page agrees with anything Jubilee teaches. It means the
            page was relevant and cleared the safety gates. Nothing more is claimed for
            it, and the block says so on every search.
          </p>
        </div>
        <p>
          We screen for material that is not family-safe and we take that seriously, but
          no filter is perfect. If something reaches you that should not have, the{' '}
          <em>Report this result</em> link under every result is the fastest way to tell
          us; enough reports suppress a page automatically while a person looks at it.
        </p>
      </Section>

      <Section n="3" title="What the quotations are">
        <p>
          The extract under each result is <strong>text taken verbatim from the page it
          links to</strong>. It is selected by matching your search words, never written,
          summarised or paraphrased by us. When a passage of scripture is shown, it is
          quoted from the JSV and nothing is added to it.
        </p>
        <p>
          This is a deliberate limit on what the service will do, not a limitation we
          intend to remove.
        </p>
      </Section>

      <Section n="4" title="Fair use of the service">
        <p>Please do not:</p>
        <ul>
          <li>
            Automate searches beyond the published limits — <strong>60 a minute</strong>{' '}
            without signing in, <strong>300 a minute</strong> with a Jubilee ID. Going
            over returns an error asking you to wait, rather than a ban.
          </li>
          <li>Copy the index wholesale, or re-publish results as though they were your own service.</li>
          <li>Use the service to find material to attack, harass or defraud anyone.</li>
          <li>Interfere with the service, or try to reach parts of it you have not been given access to.</li>
        </ul>
        <p>
          The search API exists for Jubilee&rsquo;s own sites and the embeddable widget.{' '}
          <strong>It is not open to third parties</strong>, and requests from sites that
          are not on the network are refused by design rather than by policy.
        </p>
      </Section>

      <Section n="5" title="If you publish pages we index">
        <p>
          Our crawler obeys <code>robots.txt</code>, identifies itself honestly, never
          downloads images, and stores extracted text only to build the index and show a
          quotation beside a link to you. The <Link href="/bot">crawler page</Link>{' '}
          explains how to exclude it, in whole or in part.
        </p>
        <p>
          To have a page or a site removed from the index, write to us. We act within{' '}
          <strong>five business days</strong> and you do not need to give a reason.
          Removal from the index is not an opinion about your page.
        </p>
      </Section>

      <Section n="6" title="Jubilee ID">
        <p>
          Signing in is optional and search works without it. Accounts are issued and
          governed by the Jubilee ID service under its own terms; we do not create
          accounts, hold passwords, or decide what you are permitted to do — we ask
          Jubilee ID and act on the answer.
        </p>
        <p>
          You are responsible for what is done through your Jubilee ID. Tell us, and
          Jubilee ID, if you believe someone else is using it.
        </p>
        <p>
          What signing in changes about what is recorded is set out in the{' '}
          <Link href="/privacy">privacy notice</Link>.
        </p>
      </Section>

      <Section n="7" title="Availability and accuracy">
        <p>
          The service is offered as it is. We work to keep it available and correct, and
          when the index has nothing good on a subject it is designed to say so rather
          than pad the page with weak matches — but we do not promise that it is
          complete, current, or that any particular page will be found.
        </p>
        <p>
          Search results are a starting point for your own reading, not a substitute for
          it, and least of all for pastoral or professional advice.
        </p>
      </Section>

      <Section n="8" title="Changes to these terms">
        <p>
          These terms may change as the service does. The current version is always here,
          and where a change materially affects what you may do we will say so rather
          than reissue the page quietly.
        </p>
      </Section>

      <Section n="9" title="Contact">
        {identity.contact ? (
          <p>
            <a href={`mailto:${identity.contact}`}>{identity.contact}</a>
            {identity.postalAddress && <> &middot; {identity.postalAddress}</>}
          </p>
        ) : (
          <p>The contact address has not been published yet. See the note below.</p>
        )}
      </Section>

      {missing.length > 0 && (
        <div className={styles.todo}>
          <b>These terms are a draft and must not be published as they stand.</b>
          What they say about how the service behaves is accurate and matches the
          implementation. What is missing is everything a terms document normally turns
          on, and it has been left blank rather than invented:
          <ul>
            {missing.map((m) => (
              <li key={m.key}><code>{m.key}</code> &mdash; {m.what}</li>
            ))}
          </ul>
          There is also no liability, indemnity or dispute-resolution clause here, and
          that is deliberate: those are the clauses whose wording is a legal decision
          rather than a description of software. A lawyer should draft them and review
          the rest.
        </div>
      )}

      <nav className={styles.footerNav}>
        <Link href="/">Search</Link>
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/bot">About the crawler</Link>
        <Link href="/signin">Sign in</Link>
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
