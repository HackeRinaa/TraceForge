import type { NextConfig } from 'next';

const apiOrigin = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@traceforge/contracts', '@traceforge/domain'],
  // The browser talks to the API through this same-origin proxy, so session cookies are first-party and no CORS or
  // third-party-cookie configuration is needed. Server-sent events pass through unbuffered.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
  // Compression buffers event streams; the reverse proxy in front of production should compress instead.
  compress: false,
  poweredByHeader: false,
};

export default config;
