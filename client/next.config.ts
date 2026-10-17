import type { NextConfig } from "next";

// The Hono backend always runs separately; Next is the public front door and proxies to it.
const API_URL = process.env.API_URL || "http://localhost:4021";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Tunnel hosts load the dev server from a non-localhost origin, which `next dev` blocks otherwise.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app", "*.ngrok.app", "*.ngrok.dev", "*.trycloudflare.com"],
  experimental: {
    // Must outlast the buyer's 90 s paid-call timeout. Next's 30 s default would drop the response
    // while the seller still settles, so the buyer pays and gets nothing.
    proxyTimeout: 120_000,
  },
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: `${API_URL}/auth/:path*` },
      // Vercel does not match the bare /agent against /agent/:path*, so it gets its own rule.
      { source: "/agent", destination: `${API_URL}/agent` },
      { source: "/agent/:path*", destination: `${API_URL}/agent/:path*` },
      { source: "/mcp", destination: `${API_URL}/mcp` },
      { source: "/registry/:path*", destination: `${API_URL}/registry/:path*` },
      { source: "/buyer/:path*", destination: `${API_URL}/buyer/:path*` },
      { source: "/sellers/:path*", destination: `${API_URL}/sellers/:path*` },
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/healthz", destination: `${API_URL}/healthz` },
    ];
  },
};

export default nextConfig;
