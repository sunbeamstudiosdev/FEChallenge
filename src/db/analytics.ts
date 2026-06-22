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

import { db } from "./client";
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
 * REFERENCE QUERY: applications grouped by pipeline stage, scoped to the
 * caller's workspace. `ctx` comes first on purpose — the tenant scope can't be
 * forgotten because the query can't be called without it.
 */
export async function applicationCountByStage(
  ctx: AnalyticsCtx,
  opts: { jobId?: string } = {},
) {
  const extra = opts.jobId ? [eq(applications.jobId, opts.jobId)] : [];
  return db
    .select({ stage: applications.stage, count: count() })
    .from(applications)
    .where(scopeWhere(applications, ctx, extra))
    .groupBy(applications.stage)
    .orderBy(desc(count()));
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
  return db
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
    .orderBy(desc(count()));
}

/** Candidates grouped by acquisition source (aggregate, no PII). */
export async function candidatesBySource(ctx: AnalyticsCtx) {
  return db
    .select({ source: candidates.source, count: count() })
    .from(candidates)
    .where(scopeWhere(candidates, ctx))
    .groupBy(candidates.source)
    .orderBy(desc(count()));
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
  return db
    .select({ period, count: count() })
    .from(applications)
    .where(scopeWhere(applications, ctx))
    .groupBy(period)
    .orderBy(period);
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
    return db
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
          eq(applications.stage, opts.stage),
          opts.source ? eq(candidates.source, opts.source) : undefined,
        ]),
      )
      .limit(limit);
  }

  const extra = opts.source ? [eq(candidates.source, opts.source)] : [];
  return db
    .select(selection)
    .from(candidates)
    .where(scopeWhere(candidates, ctx, extra))
    .limit(limit);
}
