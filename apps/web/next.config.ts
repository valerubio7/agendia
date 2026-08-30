import type { NextConfig } from "next";
const apiOrigin = process.env.AGENDIA_API_ORIGIN;
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() { return apiOrigin ? [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }] : []; },
};
export default config;
