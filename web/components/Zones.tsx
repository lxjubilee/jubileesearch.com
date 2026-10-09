import Link from 'next/link';
import type { ZoneABlock, ZoneBBlock } from '@/lib/types';
import Icon from './ResultsIcons';
import ResultCard from './ResultCard';
import ZoneBCollapse from './ZoneBCollapse';

// The two zones (R1, §13.5).
//
// The ordering guarantee is structural and lives in the caller: app/search/page.tsx
// renders <ZoneA /> and then <ZoneB />, in that order, in the document. There is
// no CSS in this port that could reorder them and none should be added --
// acceptance criterion 12 is "Zone A never renders below Zone B, in any client,
// at any viewport", and a `flex-direction: row-reverse` or an `order` property
// would break it silently at one breakpoint.
//
// Server components: the results are already in the HTML when it reaches the
// browser, so the guarantee holds before any JavaScript runs.

export function ZoneA({ block, query, lang, moreHref }: {
  block: ZoneABlock;
  query?: string;
  lang?: string;
  /** "View all Jubilee results": the Jubilee-only scope, offered from All. */
  moreHref?: string;
}) {
  if (block.results.length === 0) {
    // The honest empty state (§13.5). "When the network has no good answer, say
    // so plainly and give the space to Zone B." Padding this block with five
    // weak matches is the failure the whole coverage mechanism exists to
    // prevent, and every one of these is logged as a content gap.
    //
    // The query travels with the link. Without it /suggest has nothing to file
    // the request against, and the reader would be asked to type out what they
    // just searched for.
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (lang) params.set('lang', lang);
    const suggestHref = params.size ? `/suggest?${params}` : '/suggest';

    return (
      <section className="zone zone-a zone-a-empty" aria-labelledby="zone-a-heading">
        <ZoneAHeading label={block.label} />
        <p className="zone-empty-copy">
          The Jubilee network has not covered this one yet.{' '}
          <Link href={suggestHref} className="zone-empty-link">
            Tell us what you were looking for
          </Link>{' '}
          and we will pass it to the writing team.
        </p>
      </section>
    );
  }

  return (
    <section className="zone zone-a" aria-labelledby="zone-a-heading" data-coverage={block.coverage}>
      <ZoneAHeading label={block.label} moreHref={moreHref} />
      <div className="zone-results rs-grid">
        {block.results.map((result) => (
          <ResultCard key={result.page_id} result={result} zone="A" />
        ))}
      </div>
    </section>
  );
}

export function ZoneB({ block }: { block: ZoneBBlock }) {
  return (
    <ZoneBCollapse label={block.label}>
      <div className="zone-results rs-grid" id="zone-b-results">
        {block.results.length > 0 ? (
          block.results.map((result) => (
            <ResultCard key={result.page_id} result={result} zone="B" />
          ))
        ) : (
          <p className="zone-empty-copy">
            Nothing from the wider web cleared the safety gates for this search.
          </p>
        )}
      </div>
    </ZoneBCollapse>
  );
}

function ZoneAHeading({ label, moreHref }: { label: string; moreHref?: string }) {
  return (
    <div className="zone-heading-row">
      <Icon name="star" className="rs-zone-icon rs-zone-icon-a" />
      <div className="rs-zone-titles">
        <h2 id="zone-a-heading" className="zone-heading">{label}</h2>
        <p className="rs-zone-sub">Trusted. Faithful. Christ-centered.</p>
      </div>
      {moreHref && (
        <Link href={moreHref} className="rs-more" replace>
          View all Jubilee results <Icon name="arrow" />
        </Link>
      )}
    </div>
  );
}
