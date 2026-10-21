import type { NextConfig } from "next";

// The Hono backend always runs separately; Next is the public front door and proxies to it.
const API_URL = process.env.API_URL || "http://localhost:4021";
const dev = process.env.NODE_ENV !== "production";

// Everything loads from this site: fonts are self-hosted by next/font and the wallet talks to the browser extension,
// not the network. Inline scripts stay allowed because Next and next-themes inject them (nonces would force every page
// to render dynamically); the dev server also needs eval and its hot-reload socket.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

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
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
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
