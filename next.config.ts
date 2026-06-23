import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a wasm binary and uses Node built-ins; keep it external to the
  // server bundle so Next doesn't try to bundle the wasm module. On the
  // Cloudflare build the Neon driver is used instead, so PGlite is never loaded.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;

// Enables Cloudflare bindings/env during `next dev` via OpenNext. No-op in prod.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
