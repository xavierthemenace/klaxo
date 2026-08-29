import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Run server-only packages in Node instead of attempting to bundle them.
  serverExternalPackages: ['better-sqlite3', 'node:sqlite', 'pdfjs-dist'],
  output: 'standalone',
  experimental: {
    serverActions: { bodySizeLimit: '12mb' },
  },
};

export default nextConfig;
