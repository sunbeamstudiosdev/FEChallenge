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

// In Next dev, modules can be re-evaluated across HMR; stash the PGlite handle
// on globalThis so we don't open a second handle to the same directory.
const globalForDb = globalThis as unknown as { __pglite__?: unknown };

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(neon(url), { schema }) as unknown as Db;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pglite =
    (globalForDb.__pglite__ as InstanceType<typeof PGlite> | undefined) ??
    new PGlite(env.PGLITE_DIR);
  if (process.env.NODE_ENV !== "production") globalForDb.__pglite__ = pglite;
  return drizzle(pglite, { schema }) as unknown as Db;
}

export const db = await createDb();

/**
 * Memoized schema initialization. Concurrent importers share one promise so
 * the raw DDL runs exactly once per process. The DDL is `CREATE TABLE IF NOT
 * EXISTS`, so it's safe on both backends; for Neon it's typically a no-op
 * because the schema was already provisioned by the seed step.
 */
let initPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // Imported lazily to avoid a circular import (migrate.ts imports `db`).
      const { ensureSchema: run } = await import("./migrate");
      await run();
    })();
  }
  return initPromise;
}
