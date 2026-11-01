import path from "node:path";
import type { NextConfig } from "next";

// A static export: every page is plain HTML and JS, and the live data is read
// from NEAR in the visitor's browser, so the site can be hosted anywhere.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Tailwind's CSS is small and atomic, and most visitors (judges) arrive
  // cold, so inlining it removes a render-blocking request.
  experimental: { inlineCss: true },
  turbopack: {
    // The repo root, so the site can import the MCP server's verdict rules
    // (mcp/src/verdict.ts) and show exactly the verdicts it gives.
    root: path.resolve(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
