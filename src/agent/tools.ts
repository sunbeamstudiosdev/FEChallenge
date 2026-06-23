import { tool } from "ai";
import { z } from "zod";

import {
  applicationCountByStage,
  applicationsByJob,
  applicationsOverTime,
  candidatesBySource,
  findCandidates,
  SOURCES,
  STAGES,
  TIME_BUCKETS,
  type AnalyticsCtx,
} from "@/db/analytics";
import type { Display, Headline, Row, ToolResult, Trend } from "./artifact";

/**
 * The copilot's tool catalog — what the agent can actually do.
 *
 * Design principles (so a model can drive these well):
 *  - Small, focused tools, one analytical question each.
 *  - Typed inputs (Zod), `enum` for fixed choices (stage / source / bucket).
 *  - Descriptions say WHEN to call the tool, not just what it does.
 *  - NO tool takes a `workspaceId` — scope comes from `ctx` (server context)
 *    only, so a model (or a crafted user message) can't reach another tenant.
 *  - Each returns `{ rows, display }`; PII gating lives in the query layer, so
 *    an analyst's results never contain candidate name/email/phone.
 */
/** Coerce a possibly-stringified count to a number (drizzle returns counts as strings on some drivers). */
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/** Sum a numeric column across rows — the basis for the grounded headline totals. */
const total = (rows: Row[], key = "count"): number =>
  rows.reduce((sum, r) => sum + num(r[key]), 0);

/**
 * Period-over-period trend for a time series (rows are chronological). Compares
 * the latest bucket to the one before it. Returns undefined when there isn't
 * enough data (or the prior bucket is zero) so we never show a misleading delta.
 */
function timeTrend(rows: Row[], bucket: string): Trend | undefined {
  const lastRow = rows.at(-1);
  const prevRow = rows.at(-2);
  if (!lastRow || !prevRow) return undefined;
  const last = num(lastRow.count);
  const prev = num(prevRow.count);
  if (prev === 0) return undefined;
  const pct = Math.round(((last - prev) / prev) * 100);
  const direction: Trend["direction"] = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return { direction, label: `${pct > 0 ? "+" : ""}${pct}% vs the prior ${bucket}` };
}

const ok = (
  rows: ToolResult["rows"],
  display: Display,
  headline?: Headline,
): ToolResult => ({ rows, display, ...(headline ? { headline } : {}) });

/**
 * Wrap a tool body so a query failure returns a STRUCTURED error the model can
 * recover from, rather than throwing into the stream and killing the turn. The
 * model sees `{ error }` in the tool result and (per the system prompt) retries
 * or explains. `fallback` is the display to show for the (empty) error result.
 * Exported so a test can prove the repair path without reaching into the loop.
 */
export async function guard(
  fallback: Display,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (e) {
    return {
      rows: [],
      display: fallback,
      error: e instanceof Error ? e.message : "Query failed.",
    };
  }
}

export function buildTools(ctx: AnalyticsCtx) {
  return {
    // Applications by pipeline stage — the "how does my funnel look" question.
    applicationCountByStage: tool({
      description:
        "Count applications grouped by pipeline stage (applied, screen, interview, offer, hired, rejected). Call this for questions about the overall pipeline/funnel shape. Pass a jobId to scope to a single job.",
      inputSchema: z.object({
        jobId: z
          .string()
          .optional()
          .describe("Limit to one job by its id (omit for the whole workspace)."),
      }),
      execute: ({ jobId }) =>
        guard({ kind: "bar", x: "stage", y: "count", title: "Applications by stage" }, async () => {
          const rows = await applicationCountByStage(ctx, { jobId });
          return ok(
            rows,
            { kind: "bar", x: "stage", y: "count", title: "Applications by stage" },
            {
              label: jobId ? "Applications (this job)" : "Total applications",
              value: String(total(rows)),
            },
          );
        }),
    }),

    // Applications by job — "which roles are getting the most applicants".
    applicationsByJob: tool({
      description:
        "Count applications grouped by job title. Call this to compare hiring activity across open roles, or to find the busiest/quietest jobs. Optionally filter to one pipeline stage.",
      inputSchema: z.object({
        stage: z
          .enum(STAGES)
          .optional()
          .describe("Only count applications currently in this stage."),
      }),
      execute: ({ stage }) =>
        guard({ kind: "bar", x: "job", y: "count", title: "Applications by job" }, async () => {
          const rows = await applicationsByJob(ctx, { stage });
          return ok(
            rows,
            {
              kind: "bar",
              x: "job",
              y: "count",
              title: stage ? `Applications by job (${stage})` : "Applications by job",
            },
            {
              label: stage ? `Applications in ${stage}` : "Total applications",
              value: String(total(rows)),
            },
          );
        }),
    }),

    // Candidates by source — "where are our candidates coming from".
    candidatesBySource: tool({
      description:
        "Count candidates grouped by acquisition source (referral, linkedin, job_board, agency, careers_site). Call this for sourcing/channel questions like 'where are candidates coming from'.",
      inputSchema: z.object({}),
      execute: () =>
        guard({ kind: "bar", x: "source", y: "count", title: "Candidates by source" }, async () => {
          const rows = await candidatesBySource(ctx);
          return ok(
            rows,
            { kind: "bar", x: "source", y: "count", title: "Candidates by source" },
            { label: "Total candidates", value: String(total(rows)) },
          );
        }),
    }),

    // Applications over time — trend questions.
    applicationsOverTime: tool({
      description:
        "Application volume over time, bucketed by day, week, or month (based on when each application was submitted). Call this for trend questions like 'how have applications trended' or 'are we getting more applicants lately'.",
      inputSchema: z.object({
        bucket: z
          .enum(TIME_BUCKETS)
          .default("week")
          .describe("Time bucket size for the trend."),
      }),
      execute: ({ bucket }) =>
        guard({ kind: "line", x: "period", y: "count", title: "Applications over time" }, async () => {
          const rows = await applicationsOverTime(ctx, { bucket });
          return ok(
            rows,
            {
              kind: "line",
              x: "period",
              y: "count",
              title: `Applications over time (by ${bucket})`,
            },
            {
              label: "Total applications",
              value: String(total(rows)),
              trend: timeTrend(rows, bucket),
            },
          );
        }),
    }),

    // Candidate-level lookup — the PII-sensitive tool.
    findCandidates: tool({
      description:
        "List individual candidates, optionally filtered by acquisition source and/or pipeline stage. Call this when the user asks about specific people (e.g. 'who is in the interview stage', 'show candidates from referrals'). Candidate contact details (name/email/phone) are only returned to roles permitted to see them; analysts receive de-identified rows.",
      inputSchema: z.object({
        source: z
          .enum(SOURCES)
          .optional()
          .describe("Only candidates acquired through this source."),
        stage: z
          .enum(STAGES)
          .optional()
          .describe("Only candidates with an application in this pipeline stage."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe("Max rows to return (1-100)."),
      }),
      execute: ({ source, stage, limit }) =>
        guard({ kind: "table", columns: [] }, async () => {
          const rows = (await findCandidates(ctx, { source, stage, limit })) as Row[];
          // Columns reflect what was actually selected — for an analyst the PII
          // columns are absent, so they never appear in the table either.
          const columns = rows[0] ? Object.keys(rows[0]) : ["id", "source", "createdAt"];
          const capped = rows.length === limit;
          return ok(rows, { kind: "table", columns }, {
            label: capped ? `Candidates (first ${limit})` : "Candidates",
            value: String(rows.length),
          });
        }),
    }),
  };
}

export type CopilotTools = ReturnType<typeof buildTools>;
