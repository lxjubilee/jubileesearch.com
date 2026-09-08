import type { BestBet, EntityPanel as EntityPanelData, NavigationalResult, ScriptureCard as ScriptureCardData } from '@/lib/types';

// Everything that renders around the two zones: editorial pins, the scripture
// card, the entity panel, and the navigational match.
//
// All server components, and all of them render text only (P10). None of them
// authors anything (P7): the blurb is written by a human editor, the verses are
// quoted verbatim from the JSV, and the panel summary is stored verbatim from
// JubileePedia. This file formats; it does not compose.

/** R4, §13.4. Maximum two, above Zone A, visually distinct. */
export function BestBets({ bets }: { bets: BestBet[] }) {
  if (bets.length === 0) return null;
  return (
    <section className="best-bets" aria-label="Editor picks">
      {bets.map((bet) => (
        <article className="best-bet" key={bet.best_bet_id}>
          <a className="best-bet-title" href={bet.url} target="_blank" rel="noopener">
            {bet.title}
          </a>
          {/* The one place in the product where editorial prose appears in
              results, hand-written and capped at 240 characters. */}
          {bet.blurb && <p className="best-bet-blurb">{bet.blurb}</p>}
        </article>
      ))}
    </section>
  );
}

/**
 * R3, §13.2. Quoted, never paraphrased, never commented on, and cited simply as
 * JSV with no edition label.
 *
 * There is no "passage unavailable" state here on purpose. When the reference
 * cannot be resolved with certainty the engine sends no card at all and the
 * query falls through to ordinary results — "silence is correct; a wrong verse
 * is not". A null here is a decision that has already been made.
 */
export function ScriptureCard({ card }: { card: ScriptureCardData }) {
  return (
    <section className="scripture-card" aria-label="Scripture passage">
      <h2 className="scripture-reference">{card.reference}</h2>
      <div className="scripture-text">
        {card.verses.map((verse) => (
          <p className="scripture-verse" key={verse.verse}>
            <sup>{verse.verse}</sup> {verse.text}
          </p>
        ))}
      </div>
      <p className="scripture-citation">
        {card.citation}
        {card.chapter_url && (
          <> · <a href={card.chapter_url}>Read the full chapter</a></>
        )}
      </p>
    </section>
  );
}

/** R10, §7.8. Text only, verbatim from JubileePedia, and credited to it. */
export function EntityPanel({ entity }: { entity: EntityPanelData }) {
  return (
    <aside className="entity-panel" aria-label={entity.name}>
      <h2 className="entity-name">{entity.name}</h2>
      {entity.summary && <p className="entity-summary">{entity.summary}</p>}
      {entity.facts.length > 0 && (
        <dl className="entity-facts">
          {entity.facts.map((fact) => (
            <div key={fact.label} style={{ display: 'contents' }}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="entity-source">
        From <a href={entity.source_url}>{entity.source_name}</a>
      </p>
    </aside>
  );
}

/** §13.2. The reader typed a site name; give them the site. */
export function Navigational({ nav }: { nav: NavigationalResult }) {
  return (
    <section className="navigational" aria-label="Site match">
      <a className="navigational-title" href={nav.url}>{nav.title}</a>
      <span className="navigational-host">{nav.host}</span>
      {nav.deep_links.length > 0 && (
        <nav className="navigational-links">
          {nav.deep_links.map((link) => (
            <a key={link.url} href={link.url}>{link.title ?? link.url}</a>
          ))}
        </nav>
      )}
    </section>
  );
}
