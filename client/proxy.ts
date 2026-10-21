import { NextResponse, type NextRequest } from "next/server";

// Every API call reaches the Hono backend from Vercel's own addresses, so the backend cannot tell visitors apart for its
// rate limits. This names the visitor in a header, next to a secret shared with the backend (PROXY_SECRET on both sides).
// Vercel overwrites x-forwarded-for / x-real-ip with the real client address, so they cannot be spoofed here.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Never pass on a copy the browser sent itself.
  headers.delete("x-gandiva-proxy");
  headers.delete("x-gandiva-client-ip");
  const secret = process.env.PROXY_SECRET;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  if (secret && ip) {
    headers.set("x-gandiva-proxy", secret);
    headers.set("x-gandiva-client-ip", ip);
  }
  return NextResponse.next({ request: { headers } });
}

// The same paths next.config.ts rewrites to the backend.
export const config = {
  matcher: ["/auth/:path*", "/agent", "/agent/:path*", "/mcp", "/registry/:path*", "/buyer/:path*", "/sellers/:path*", "/api/:path*", "/healthz"],
};
