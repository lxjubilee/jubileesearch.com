import type { Metadata, Viewport } from 'next';
import InspireRail from '@/components/InspireRail';
import '../globals.css';
import '../inspire-rail.css';

// The two stylesheets are the ones the static site shipped, byte for byte. They
// are not being rewritten into CSS modules on the way across: that CSS *is* the
// design — the vertical rhythm in it was matched box for box against
// JubileeInspire's chat welcome state — and re-expressing it would risk drift
// for no benefit the reader can see.

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'https://www.jubileesearch.com'),
  title: {
    default: 'JubileeSearch',
    template: '%s - JubileeSearch',
  },
  description: 'Search the Jubilee network and a family-safe window on the wider web.',
  icons: { icon: '/images/personas/jubilee.png', apple: '/images/personas/jubilee.png' },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600&family=Oswald:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      {/* `jir-on` is what gives the body its left offset for the rail. */}
      <body className="jir-on">
        <InspireRail />
        {children}
      </body>
    </html>
  );
}
