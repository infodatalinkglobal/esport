/**
 * Next.js configuration.
 *
 * `distDir` note: `next dev` and `next build` both write into the same output
 * directory by default, so running `npm run build` while the dev server is
 * serving a preview wipes the dev server's JavaScript and CSS (the page then
 * renders as unstyled HTML). Setting `NEXT_DIST_DIR` lets a production build be
 * verified in its own folder without disturbing a running dev server:
 *
 *   NEXT_DIST_DIR=.next-build npm run build
 *
 * On Vercel the variable is unset, so the output stays the default `.next`.
 */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The MVP has no lint tooling installed — keep builds fast and dependency-free.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // Every page reads live tournament data, so nothing is cached at build time.
  // (Individual pages also opt out with `export const dynamic = 'force-dynamic'`.)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Nothing on this site has a reason to be framed elsewhere.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // Previews and localhost are http; real deployments are https only.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
