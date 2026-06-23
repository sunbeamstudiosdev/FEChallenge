import next from "eslint-config-next/core-web-vitals";

/**
 * Flat ESLint config.
 *
 * Beyond Next's defaults, this enforces the project's tenant-isolation
 * invariant AT BUILD TIME (see the "tenant-table fence" block below): the raw
 * tenant tables can only be imported inside the scoped data layer, so a
 * cross-tenant query can't even be written elsewhere. "You can't forget the
 * workspace filter" becomes a lint error in CI, not a code-review comment.
 */
const config = [
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".turbo/**",
      ".claude/**",
      "node_modules/**",
      "ui/**",
      "cloudflare-env.d.ts",
      "next-env.d.ts",
    ],
  },

  ...next,

  // === Tenant-table fence ===================================================
  // The tenant tables (candidates/applications/jobs/users) carry workspace_id
  // and MUST only be queried through the scoped functions in @/db/analytics,
  // which route every WHERE through scopeWhere + run under RLS. Importing a
  // tenant table object anywhere else is the one way to bypass that, so we make
  // that import a hard error. `workspaces` (the directory table, no
  // workspace_id, read across tenants for the switcher) is intentionally NOT
  // fenced. The data layer itself (src/db/**) is the allowed zone, and tests
  // are exempt because the RLS-proof test deliberately does a raw read.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/db/**", "src/**/__tests__/**", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db/schema",
              importNames: ["candidates", "applications", "jobs", "users"],
              message:
                "Tenant tables are query-able only via the scoped functions in @/db/analytics (scopeWhere + RLS). Importing them here would bypass tenant isolation.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
