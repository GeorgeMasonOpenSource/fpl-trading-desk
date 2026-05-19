/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    serverActions: { allowedOrigins: ['*'] }
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
