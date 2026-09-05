import type { NextConfig } from "next";
import { resolve } from "node:path";
const apiOrigin = process.env.AGENDIA_API_ORIGIN;
const config: NextConfig = {
  agentRules: false,
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  async rewrites() {
    return apiOrigin
      ? [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }]
      : [];
  },
};
export default config;
