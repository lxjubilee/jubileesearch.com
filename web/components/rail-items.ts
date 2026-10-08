// This site's own rows in the JubileeInspire rail.
//
// Everything between them — Born Again DNA, Jubilee News, Jubilee Radio and the
// rest — is the shared block, loaded at runtime from JubileeInspire (see
// useCommonRail.ts) and edited at jubileeinspire.com/admin/rail. Do not add a
// family property here: it would show on this site only, and drift from the
// list every other property shows.
//
// The paths are Material Symbols glyphs copied from the static site.

export interface RailItem {
  label: string;
  href: string;
  /** The `d` attribute, in the -960 960 viewBox. */
  path: string;
  /** The row for the site you are on: marked, and not a link to itself. */
  active?: boolean;
}

export const RAIL_VIEWBOX = '0 -960 960 960';

/** First row, above the shared block — as on JubileeInspire. */
export const NEW_CHAT: RailItem = {
  label: 'New Chat',
  href: 'https://www.jubileeinspire.com/chat?new=1',
  path: 'M120-160v-600q0-33 23.5-56.5T200-840h480q33 0 56.5 23.5T760-760v203q-10-2-20-2.5t-20-.5q-10 0-20 .5t-20 2.5v-203H200v400h283q-2 10-2.5 20t-.5 20q0 10 .5 20t2.5 20H240L120-160Zm160-440h320v-80H280v80Zm0 160h200v-80H280v80Zm400 280v-120H560v-80h120v-120h80v120h120v80H760v120h-80ZM200-360v-400 400Z',
};

/** Last row, below the shared block: this site, marked as where you are. */
export const THIS_SITE: RailItem = {
  label: 'Jubilee Search',
  href: '/',
  active: true,
  path: 'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z',
};

/** Bare host, no `www.` — how a shared row is recognised as this site. */
export const THIS_HOST = 'jubileesearch.com';
