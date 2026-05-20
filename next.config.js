/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    serverActions: { allowedOrigins: ['*'] }
  },
  // We still run `npm run lint` manually + on the GitHub Actions runner, but
  // we don't want a benign rule violation in pre-existing prose to fail
  // production deploys on Vercel. `next build` is the gate for type and
  // runtime errors; ESLint is advisory.
  eslint: {
    ignoreDuringBuilds: true
  },
  // Static assets stay on the edge; API routes default to Node for pg compatibility.
  // Keep cold starts under control by relying on cached DB rows for reads.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' }
        ]
      }
    ];
  }
};

module.exports = nextConfig;
