import { resolve } from "node:path";

import { defineConfig } from "evalite/config";

/**
 * Evalite runs its own Vite, so re-declare the `@` → `src` alias the app uses
 * (mirrors `vitest.config.ts`). Storage is left as the default (in-memory), so
 * evals need zero setup — no database, no native deps.
 */
export default defineConfig({
  viteConfig: {
    resolve: {
      alias: { "@": resolve(process.cwd(), "src") },
    },
  },
});
