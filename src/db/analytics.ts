import {
  and,
  count,
  desc,
  eq,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { db, isNeon } from "./client";
import { canReadColumn, type Role } from "./permissions";
import { applications, candidates, jobs } from "./schema";

/**
 * Scoped analytics data layer for the copilot.
 *
 * Two hard requirements hold for EVERY function here:
 *  1. TENANT SCOPING — every query is constrained to `ctx.workspaceId` via
 *     `scopeWhere`, so a query can never read another workspace's rows. `ctx`
 *     is the first argument of every query, so the scope can't be forgotten.
 *  2. PII PERMISSIONS — candidate PII (name / email / phone) is gated by role.
 *     `candidateSelection` builds the SQL projection from `canReadColumn`, so an
 *     `analyst` never even SELECTs PII — the result can't carry it.
 *
 * The copilot's tools (src/agent/tools.ts) call these; they never write SQL.
 */

export type AnalyticsCtx = { workspaceId: string; role: Role };

/** Stages and sources match the seed; tools expose these as enums to the model. */
export const STAGES = [
  "applied",
  "screen",
  "interview",
  "offer",
  "hired",
  "rejected",
] as const;
export type Stage = (typeof STAGES)[number];

export const SOURCES = [
  "referral",
  "linkedin",
  "job_board",
  "agency",
  "careers_site",
] as const;
export type Source = (typeof SOURCES)[number];

export const TIME_BUCKETS = ["day", "week", "month"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

/** The one place tenant scoping lives: AND-s the workspace filter into a query. */
function scopeWhere(
  table: { workspaceId: AnyColumn },
  ctx: AnalyticsCtx,
  extra: Array<SQL | undefined> = [],
): SQL {
  const parts = [eq(table.workspaceId, ctx.workspaceId), ...extra].filter(
    (p): p is SQL => p !== undefined,
  );
  // Always has at least the workspace filter, so it's never undefined.
  return and(...parts)!;
}

/**
 * PII gating BY CONSTRUCTION. Builds the candidate column projection for the
 * caller's role: non-PII columns always; PII columns only when `canReadColumn`
 * allows it. For an `analyst`, name/email/phone are never added to the SELECT,
 * so the DB never returns them — there is nothing to "strip" later.
 */
function candidateSelection(ctx: AnalyticsCtx): Record<string, PgColumn> {
  const columns: Record<string, PgColumn> = {
    id: candidates.id,
    source: candidates.source,
    createdAt: candidates.createdAt,
  };
  const piiColumns = {
    name: candidates.name,
    email: candidates.email,
    phone: candidates.phone,
  } as const;
  for (const [name, col] of Object.entries(piiColumns)) {
    if (canReadColumn(ctx.role, "candidates", name)) columns[name] = col;
  }
  return columns;
}

/**
 * Run a scoped read with the Row-Level Security key (`app.workspace_id`) set for
 * this request, ATOMICALLY with the query so the two share one DB connection.
 * This is the DB-layer twin of `scopeWhere`: even a query that forgot the
 * workspace filter would still only see this workspace's rows (RLS in
 * `migrate.ts`). Exported so a test can prove RLS works on its own.
 *
 * neon-http has no interactive transactions, but `batch()` runs both statements
 * in one HTTP request on one connection; PGlite uses an interactive transaction.
 * `set_config(..., true)` is transaction-local, so the setting never leaks.
 */
export async function scoped<T>(
  ctx: AnalyticsCtx,
  build: (x: typeof db) => PromiseLike<T>,
): Promise<T> {
  // Drop to the restricted role so RLS applies, then set the workspace key, then
  // run the query — all in one transaction so the role/key are scoped to it.
  const asAppUser = sql.raw("SET LOCAL ROLE app_user");
  const setKey = sql`select set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
  if (isNeon) {
    const runner = db as unknown as {
      batch: (q: unknown[]) => Promise<unknown[]>;
    };
    const [, , rows] = await runner.batch([
      db.execute(asAppUser),
      db.execute(setKey),
      build(db),
    ]);
    return rows as T;
  }
  const runner = db as unknown as {
    transaction: (fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  };
  return runner.transaction(async (tx) => {
    await tx.execute(asAppUser);
    await tx.execute(setKey);
    return await build(tx);
  });
}

/**
 * REFERENCE QUERY: applications grouped by pipeline stage, scoped to the
 * caller's workspace. `ctx` comes first on purpose — the tenant scope can't be
 * forgotten because the query can't be called without it.
 */
export async function applicationCountByStage(
  ctx: AnalyticsCtx,
  opts: { jobId?: string } = {},
) {
  const extra = opts.jobId ? [eq(applications.jobId, opts.jobId)] : [];
  return scoped(ctx, (x) =>
    x
      .select({ stage: applications.stage, count: count() })
      .from(applications)
      .where(scopeWhere(applications, ctx, extra))
      .groupBy(applications.stage)
      .orderBy(desc(count())),
  );
}

/**
 * Applications grouped by JOB (title), optionally filtered to one stage.
 * Joins jobs; both tenant tables are pinned to the workspace (scopeWhere pins
 * applications, the extra clause pins jobs) so a join can't widen the scope.
 */
export async function applicationsByJob(
  ctx: AnalyticsCtx,
  opts: { stage?: Stage } = {},
) {
  return scoped(ctx, (x) =>
    x
      .select({ job: jobs.title, count: count() })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(
        scopeWhere(applications, ctx, [
          eq(jobs.workspaceId, ctx.workspaceId),
          opts.stage ? eq(applications.stage, opts.stage) : undefined,
        ]),
      )
      .groupBy(jobs.title)
      .orderBy(desc(count())),
  );
}

/** Candidates grouped by acquisition source (aggregate, no PII). */
export async function candidatesBySource(ctx: AnalyticsCtx) {
  return scoped(ctx, (x) =>
    x
      .select({ source: candidates.source, count: count() })
      .from(candidates)
      .where(scopeWhere(candidates, ctx))
      .groupBy(candidates.source)
      .orderBy(desc(count())),
  );
}

/**
 * Application volume over time, bucketed by day/week/month on `appliedAt`.
 * `bucket` is a bound parameter to `date_trunc` and is constrained to a fixed
 * enum by the calling tool, so it can't be used for injection.
 */
export async function applicationsOverTime(
  ctx: AnalyticsCtx,
  opts: { bucket?: TimeBucket } = {},
) {
  const bucket = opts.bucket ?? "week";
  const period = sql<string>`to_char(date_trunc(${bucket}, ${applications.appliedAt}), 'YYYY-MM-DD')`;
  // Group/order by ordinal position: a bound param inside the expression keeps
  // Postgres from text-matching a repeated GROUP BY of the same fragment, and
  // the 'YYYY-MM-DD' format makes lexical order chronological.
  return scoped(ctx, (x) =>
    x
      .select({ period, count: count() })
      .from(applications)
      .where(scopeWhere(applications, ctx))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  );
}

/**
 * Candidate-level lookup — the PII-sensitive query. Optionally filter by
 * acquisition `source` and/or pipeline `stage` (the latter via a scoped join to
 * applications). The projection is PII-gated by role: an `analyst` gets
 * id/source/createdAt (+ stage/job when filtering by stage) but NEVER
 * name/email/phone, because those columns are never selected for that role.
 */
export async function findCandidates(
  ctx: AnalyticsCtx,
  opts: { source?: Source; stage?: Stage; limit?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const selection = candidateSelection(ctx);

  if (opts.stage) {
    // Capture into consts so the narrowing survives into the scoped() closure.
    const stage = opts.stage;
    const source = opts.source;
    return scoped(ctx, (x) =>
      x
        .select({
          ...selection,
          stage: applications.stage,
          jobId: applications.jobId,
        })
        .from(candidates)
        .innerJoin(applications, eq(applications.candidateId, candidates.id))
        .where(
          scopeWhere(candidates, ctx, [
            eq(applications.workspaceId, ctx.workspaceId),
            eq(applications.stage, stage),
            source ? eq(candidates.source, source) : undefined,
          ]),
        )
        .limit(limit),
    );
  }

  const extra = opts.source ? [eq(candidates.source, opts.source)] : [];
  return scoped(ctx, (x) =>
    x.select(selection).from(candidates).where(scopeWhere(candidates, ctx, extra)).limit(limit),
  );
}
