import Link from 'next/link';
import type { ZoneABlock, ZoneBBlock } from '@/lib/types';
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

export function ZoneA({ block }: { block: ZoneABlock }) {
  if (block.results.length === 0) {
    // The honest empty state (§13.5). "When the network has no good answer, say
    // so plainly and give the space to Zone B." Padding this block with five
    // weak matches is the failure the whole coverage mechanism exists to
    // prevent, and every one of these is logged as a content gap.
    return (
      <section className="zone zone-a zone-a-empty" aria-labelledby="zone-a-heading">
        <h2 id="zone-a-heading" className="zone-heading">{block.label}</h2>
        <p className="zone-empty-copy">
          The Jubilee network has not covered this one yet.{' '}
          <Link href="/suggest" className="zone-empty-link">
            Tell us what you were looking for
          </Link>{' '}
          and we will pass it to the writing team.
        </p>
      </section>
    );
  }

  return (
    <section className="zone zone-a" aria-labelledby="zone-a-heading" data-coverage={block.coverage}>
      <h2 id="zone-a-heading" className="zone-heading">{block.label}</h2>
      <div className="zone-results">
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
      <div className="zone-results" id="zone-b-results">
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
