/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    serverActions: { allowedOrigins: ['*'] },
    // `javascript-lp-solver` is a CommonJS package that MUTATES its own
    // module object during Solve() (sets `lastSolvedModel`). When webpack
    // bundles it into the server build, the mutation either fails ("e is
    // not a function" because functions get renamed) or hits the frozen
    // module namespace ("Cannot set property"). Marking it as external
    // tells Next.js to leave it as a runtime `require()` so it keeps its
    // own mutable module object and its own minified function names.
    serverComponentsExternalPackages: ['javascript-lp-solver']
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
