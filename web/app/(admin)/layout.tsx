import type { Metadata, Viewport } from 'next';
import './admin.css';

// Root layout for the admin console (§15).
//
// A third root layout beside `(site)` and `(bare)`. The console shares nothing
// with the search UI: no InspireRail, no results chrome, no Google Fonts, and a
// denser type scale, because this is a working surface rather than a reading
// one. Putting it under `(site)` would mean every operator screen inheriting a
// stylesheet built for a search page.

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s - JubileeSearch admin' },
  // Never indexed, and never followed. next.config.ts already sends
  // X-Robots-Tag: noindex on everything but /bot; this is the same statement in
  // the document, for anything that reads one and not the other.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: '#111214',
  width: 'device-width',
  initialScale: 1,
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
