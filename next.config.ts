import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // react-markdown and remark-gfm are ESM-only packages. Without this, Next.js
  // can't bundle them correctly and remark plugins silently fail to apply —
  // tables and other GFM syntax render as raw markdown instead of HTML.
  transpilePackages: ["react-markdown", "remark-gfm"],
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default config;
