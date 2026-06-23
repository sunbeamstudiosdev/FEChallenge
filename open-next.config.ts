import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// This app is fully dynamic (chat + tRPC), so there's no ISR/incremental cache
// to back with R2 — the default config is all we need.
export default defineCloudflareConfig();
