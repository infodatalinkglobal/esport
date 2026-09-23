/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MVP has no lint/format tooling installed — keep builds fast and dependency-free.
  eslint: { ignoreDuringBuilds: true },
  // Every page reads live tournament data, so nothing should be statically cached at build time.
  // (Individual pages opt out with `export const dynamic = 'force-dynamic'`.)
  poweredByHeader: false,
};

export default nextConfig;
