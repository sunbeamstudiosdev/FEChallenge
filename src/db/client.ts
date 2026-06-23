import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { env } from "@/env";
import * as schema from "./schema";

/**
 * Two backends, one `db`:
 *  - Production / Cloudflare Workers: Neon serverless Postgres over HTTP,
 *    selected when DATABASE_URL is set. Runs on workerd (fetch-based, no Node
 *    built-ins, no wasm).
 *  - Local dev / tests / evals: file-backed PGlite, zero setup, deterministic.
 *
 * Both are Postgres, so the whole scoped query layer (analytics.ts), the PII
 * permissions, and the evals are byte-for-byte identical across the two — only
 * this file changes. Each driver is loaded with a dynamic import so the unused
 * one is never pulled in; in particular PGlite (wasm + Node built-ins) never
 * enters the Workers bundle, where it can't run. It's also marked external in
 * next.config.ts.
 */
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Neon in production (Workers) and whenever DATABASE_URL is explicitly set (e.g.
 * seeding Neon locally); PGlite otherwise. The NODE_ENV half also lets a
 * production `next build` fold the condition to `true` so the bundler drops the
 * PGlite branch (keeps its wasm out of the Worker). Exported so the query layer
 * knows which transaction model to use for RLS (batch vs interactive).
 */
export const isNeon =
  process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL);

// In Next dev, modules can be re-evaluated across HMR; stash the PGlite handle
// on globalThis so we don't open a second handle to the same directory.
const globalForDb = globalThis as unknown as { __pglite__?: unknown };

async function createDb(): Promise<Db> {
  if (isNeon) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    // DATABASE_URL is unset during the build itself (no request runs then), so
    // fall back to a placeholder that parses but is never queried. On Workers the
    // real value is always present from the secret.
    const url =
      process.env.DATABASE_URL ?? "postgresql://user:pass@placeholder.neon.tech/db";
    return drizzle(neon(url), { schema }) as unknown as Db;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  // Under the test runner use an in-memory database: vitest runs files in
  // parallel workers, and a shared file-backed PGlite directory would have two
  // wasm instances contend for the same files (and abort). In dev and `db:seed`
  // we stay file-backed so the seed and `next dev` share one database.
  const pglite =
    (globalForDb.__pglite__ as InstanceType<typeof PGlite> | undefined) ??
    (process.env.VITEST ? new PGlite() : new PGlite(env.PGLITE_DIR));
  // Only reachable outside production, so always cache for HMR reuse.
  globalForDb.__pglite__ = pglite;
  return drizzle(pglite, { schema }) as unknown as Db;
}

export const db = await createDb();

/**
 * Memoized schema initialization for local/dev/test. Concurrent importers share
 * one promise so the DDL runs once per process.
 *
 * On Neon (production) this is a no-op: the schema and RLS policies are
 * provisioned once by the seed step (`runMigrations`), not on every cold start
 * (which would be wasteful and could race across isolates).
 */
let initPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      if (isNeon) return;
      // Imported lazily to avoid a circular import (migrate.ts imports `db`).
      const { runMigrations } = await import("./migrate");
      await runMigrations();
    })();
  }
  return initPromise;
}
