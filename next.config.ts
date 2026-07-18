import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Disable strict mode in production — saves ~20% build time & memory
  // (double-rendering in dev only, no effect on production behavior)
  reactStrictMode: false,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Experimental: reduce build memory for low-end servers
  experimental: {
    // Optimize package imports to reduce bundle size
    optimizePackageImports: [],
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-XSS-Protection", value: "1; mode=block" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
    {
      source: "/api/:path*",
      headers: [
        { key: "X-RateLimit-Policy", value: "100;w=60" },
      ],
    },
  ],
};

export default nextConfig;