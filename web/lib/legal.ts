// The facts a legal document needs that only Jubilee can supply.
//
// Both /privacy and /terms are accurate about what the software does, because
// that is knowable from the software. They cannot be accurate about which legal
// entity publishes them, under which law, or where to write — and inventing
// those would be worse than leaving them blank, because a plausible-looking
// company name and jurisdiction in a privacy notice is a false statement to
// every reader and regulator who relies on it.
//
// So the blanks are configuration, and both pages show what is still missing
// until they are filled. The same pattern as the bot page's D7 placeholder.

export interface LegalIdentity {
  entity: string | null;
  contact: string | null;
  postalAddress: string | null;
  jurisdiction: string | null;
  effectiveDate: string | null;
}

export function legalIdentity(): LegalIdentity {
  return {
    entity: process.env.LEGAL_ENTITY ?? null,
    // Falls back to the crawler's contact: §17 wants removal requests answered
    // "through a published contact", and that address is the same one the bot
    // page publishes for exactly that purpose (decision D7).
    contact: process.env.LEGAL_CONTACT_EMAIL ?? process.env.BOT_CONTACT_EMAIL ?? null,
    postalAddress: process.env.LEGAL_POSTAL_ADDRESS ?? null,
    jurisdiction: process.env.LEGAL_JURISDICTION ?? null,
    effectiveDate: process.env.LEGAL_EFFECTIVE_DATE ?? null,
  };
}

/** What is still unfilled, in the words a reader of the page would use. */
export function missingLegalFacts(identity: LegalIdentity): { key: string; what: string }[] {
  const missing: { key: string; what: string }[] = [];
  if (!identity.entity) {
    missing.push({ key: 'LEGAL_ENTITY', what: 'the legal entity publishing this document' });
  }
  if (!identity.contact) {
    missing.push({
      key: 'LEGAL_CONTACT_EMAIL',
      what: 'an address for privacy and removal requests — this is decision D7, and §17 requires it before the first external crawl',
    });
  }
  if (!identity.jurisdiction) {
    missing.push({ key: 'LEGAL_JURISDICTION', what: 'the governing law and venue' });
  }
  if (!identity.effectiveDate) {
    missing.push({ key: 'LEGAL_EFFECTIVE_DATE', what: 'the date this version takes effect' });
  }
  return missing;
}

export const ENTITY_FALLBACK = 'Jubilee Software, Inc.';
