// Take-home simplification: tables are created from raw DDL so the app runs
// with zero setup. In production we use drizzle-kit migrations.
//
// This DDL mirrors src/db/schema.ts column-for-column. If you change the
// schema, change it here too (or, in a real project, generate a migration).

import { sql } from "drizzle-orm";

import { db } from "./client";

export async function runMigrations(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "workspaces" (
      "id"   text PRIMARY KEY NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "name" text NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "users" (
      "id"           text PRIMARY KEY NOT NULL,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
      "name"         text NOT NULL,
      "email"        text NOT NULL,
      "role"         text NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "jobs" (
      "id"           text PRIMARY KEY NOT NULL,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
      "title"        text NOT NULL,
      "department"   text NOT NULL,
      "location"     text NOT NULL,
      "status"       text NOT NULL,
      "created_at"   timestamp NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "candidates" (
      "id"           text PRIMARY KEY NOT NULL,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
      "name"         text NOT NULL,
      "email"        text NOT NULL,
      "phone"        text NOT NULL,
      "source"       text NOT NULL,
      "created_at"   timestamp NOT NULL
    );
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "applications" (
      "id"           text PRIMARY KEY NOT NULL,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
      "candidate_id" text NOT NULL REFERENCES "candidates"("id"),
      "job_id"       text NOT NULL REFERENCES "jobs"("id"),
      "stage"        text NOT NULL,
      "applied_at"   timestamp NOT NULL,
      "updated_at"   timestamp NOT NULL
    );
  `);

  await applyRowLevelSecurity();
}

/**
 * Tenant Row-Level Security: a second enforcement layer UNDER `scopeWhere`.
 * Even if an app-layer query forgot the workspace filter, the database itself
 * only returns rows for the workspace set in `app.workspace_id`.
 *
 * How it engages on both backends: the app assumes a restricted, non-superuser
 * `app_user` role for reads (via `SET LOCAL ROLE` in `scoped()`), and RLS
 * applies to that role. The seed connects as the owner (a superuser on PGlite),
 * which bypasses RLS, so it loads both workspaces in one pass without needing
 * write policies. `current_setting(..., true)` returns NULL when the key is
 * unset, so an unscoped read returns NOTHING (fail-closed).
 *
 * The `workspaces` directory table has no `workspace_id` and is read across
 * tenants for the switcher, so it is intentionally left without RLS (and is read
 * as the owner, not `app_user`).
 */
const TENANT_TABLES = ["users", "jobs", "candidates", "applications"] as const;

async function applyRowLevelSecurity(): Promise<void> {
  try {
    await db.execute(sql.raw(`CREATE ROLE app_user NOLOGIN`));
  } catch {
    // Role already exists from a previous run.
  }
  // Let the owner assume the role (needed on Neon; harmless for a PGlite superuser).
  await db.execute(sql.raw(`GRANT app_user TO CURRENT_USER`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO app_user`));

  for (const t of TENANT_TABLES) {
    await db.execute(sql.raw(`GRANT SELECT ON "${t}" TO app_user`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`DROP POLICY IF EXISTS "${t}_tenant_select" ON "${t}"`));
    await db.execute(
      sql.raw(
        `CREATE POLICY "${t}_tenant_select" ON "${t}" FOR SELECT TO app_user ` +
          `USING (workspace_id = current_setting('app.workspace_id', true))`,
      ),
    );
  }
}
