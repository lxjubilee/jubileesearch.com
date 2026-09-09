import type { Metadata, Viewport } from 'next';
import './jubilee-id.css';

// The auth root layout — a fourth beside (site), (bare) and (admin).
//
// The door is a two-panel, full-viewport screen: form on the left, backdrop and
// scripture on the right. It cannot live under (site), whose <body class="jir-on">
// reserves a left offset for the JubileeInspire rail — the door would render in
// the remaining strip with a navigation rail beside a sign-in form, which is
// noise on the way to typing an email.
//
// Only the fonts the door actually sets: Open Sans for the body, and Agency FB
// (self-hosted, declared in jubilee-id.css) for the wordmark and the heading.

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'https://www.jubileesearch.com'),
  title: 'JubileeSearch — Sign in with your Jubilee ID',
  // A sign-in screen is per-visitor and must never be indexed or cached.
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: '/images/personas/jubilee.png', apple: '/images/personas/jubilee.png' },
};

export const viewport: Viewport = {
  themeColor: '#1a1a1a',
  width: 'device-width',
  initialScale: 1,
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
