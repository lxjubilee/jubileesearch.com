import type { NextConfig } from 'next';

// Port 3038 is not arbitrary: ops/config/websites-services.json already
// registers jubileesearch as a Node app on that port, and
// ops/config/cloudflare-config.yml maps www -> :3038 and
// api.jubileesearch.com -> :4038 through the `inspire-gateway` tunnel. So this
// app slots into the deployment that already exists, and the engine keeps its
// own port.

const ENGINE = (process.env.ENGINE_API_URL ?? 'http://127.0.0.1:4038').replace(/\/$/, '');

const config: NextConfig = {
  reactStrictMode: true,

  async rewrites() {
    return [
      // Same-origin /api/* for the browser. The alternative is CORS on the
      // engine plus a second origin in the CSP, to achieve exactly this.
      //
      // Server components do NOT come through here -- lib/api.ts talks to the
      // engine directly, which is one hop fewer and does not depend on this
      // rewrite being right.
      { source: '/api/v1/:path*', destination: `${ENGINE}/api/v1/:path*` },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // §17 Legal: the crawler honours robots directives on other people's
          // sites. This is the same courtesy in reverse -- a search results page
          // is not something another engine should index.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        // The bot page is the exception and must be indexable: §9.4 requires it
        // to exist at the URL the crawler's user agent advertises, and a
        // webmaster who follows that link has to be able to find it.
        source: '/bot',
        headers: [{ key: 'X-Robots-Tag', value: 'index, follow' }],
      },
    ];
  },
};

export default config;
