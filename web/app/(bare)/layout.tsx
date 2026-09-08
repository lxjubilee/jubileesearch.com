import type { Metadata, Viewport } from 'next';
import '../globals.css';

// The second root layout.
//
// `(site)` and `(bare)` are both root layouts — each renders its own <html> and
// <body> — which is Next's way of saying two parts of one site have genuinely
// different shells. Here the difference is the JubileeInspire rail: the bot
// information page does not get one, and that is not an oversight in bot.html.
// Whoever lands there followed a user-agent string out of a server log; they
// want to know what the crawler is and how to stop it, and a navigation rail
// into a ministry network is noise on the way to that.
//
// The cost is that moving between the two groups is a full page load rather
// than a client navigation. For a page reached from an access log, that is not
// a cost at all.

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'https://www.jubileesearch.com'),
  icons: { icon: '/images/personas/jubilee.png' },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function BareLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700&family=Oswald:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
