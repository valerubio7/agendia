import type { NextConfig } from "next";
const apiOrigin = process.env.AGENDIA_API_ORIGIN;
const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return apiOrigin
      ? [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }]
      : [];
  },
};
export default config;
