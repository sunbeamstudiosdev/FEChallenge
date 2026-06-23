# Architecture

A map of how the ATS analytics copilot fits together, and how to extend it. The
goal of this doc is that the next engineer can add a feature without having to
reverse-engineer the codebase first.

## The one idea

Both hard guarantees are enforced in the **query layer**, by construction, not in the UI or the prompt. They hold no matter what the model does or what a user types.

1. **Tenant isolation.** Every read is scoped to one workspace.
2. **PII permissions.** An analyst never receives candidate name / email / phone.

Everything below follows from keeping those two facts true in one place.

## Request path

```
Browser (src/app/page.tsx)
  │  useChat → POST /api/chat        (x-workspace, x-role headers)
  ▼
/api/chat (src/app/api/chat/route.ts)
  │  tenantFromHeaders(req) → { workspaceId, role }   ← the ONLY source of identity
  ▼
streamCopilot (src/agent/run.ts)
  │  streamText({ model, tools: buildTools(ctx), stopWhen: stepCountIs(6) })
  ▼
tools (src/agent/tools.ts)            the model picks a tool + fills typed params
  │  each tool calls a query with ctx, returns { rows, display }
  ▼
analytics (src/db/analytics.ts)       scopeWhere + candidateSelection
  │
  ▼
PGlite (local/test) or Neon Postgres (prod)   ← src/db/client.ts picks the driver
```

The same `display` hint that comes back from a tool drives the chart/table the UI renders, and the same query layer is what the evals and the guarantee tests assert against. One contract, used three ways.

## The two guarantees, in code

**Tenant scope: `scopeWhere(table, ctx, extra)` in `src/db/analytics.ts`.**
Every query takes `ctx` as its first argument and routes its `WHERE` through
`scopeWhere`, which AND-s `workspace_id = ctx.workspaceId` into the filter. You
cannot express a query without the tenant scope. Joins pin *both* tenant tables to the workspace (see `applicationsByJob`, `findCandidates`).

**PII: `candidateSelection(ctx)` in `src/db/analytics.ts`.**
It builds the candidate column projection from `canReadColumn` (`src/db/permissions.ts`). For an analyst, name/email/phone are never added to the `SELECT`, so the database never returns them. PII is unrepresentable in the result, not stripped afterward.

**Identity comes only from server context.** `workspaceId` and `role` are read from the `x-workspace` / `x-role` headers in `src/server/context.ts`. No tool accepts a `workspaceId` or `role` argument (there is a test that fails if one ever does), so the model can never reach another workspace.

## Where things live

- `src/db/`: `schema.ts`, `seed.ts`, `migrate.ts` (DDL + RLS), `client.ts`
  (PGlite vs Neon), `analytics.ts` (the scoped query layer), `permissions.ts`
  (the PII rule).
- `src/agent/`: `tools.ts` (the catalog), `run.ts` (the loop), `provider.ts`
  (model + gateway), `artifact.ts` (`Display` / `ToolResult`), `mock-model.ts`.
- `src/server/`: `trpc.ts`, `routers/app.ts`, `context.ts`.
- `src/app/`: `page.tsx` (chat UI), `providers.tsx`, `api/chat`, `api/trpc`.
- `evals/`: Evalite `*.eval.ts`. `src/__tests__/guarantees.test.ts`: the CI gate.

## Add a new tool in 5 minutes

Mirror the `applicationCountByStage` reference. Say you want "offer acceptance rate by job".

**1. Add a scoped query** in `src/db/analytics.ts`. `ctx` first; route the `WHERE` through `scopeWhere`; for candidate data use `candidateSelection(ctx)`.

```ts
export async function offerAcceptanceByJob(ctx: AnalyticsCtx) {
  return db
    .select({ job: jobs.title, /* ...counts... */ })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(scopeWhere(applications, ctx, [eq(jobs.workspaceId, ctx.workspaceId)]))
    .groupBy(jobs.title);
}
```

**2. Add the tool** in `src/agent/tools.ts`. Typed Zod input (use the `STAGES` /
`SOURCES` / `TIME_BUCKETS` enums for fixed choices), a prescriptive description that says *when* to call it, wrapped in `guard()`, returning `{ rows, display }`.

```ts
offerAcceptanceByJob: tool({
  description:
    "Offer acceptance rate per job. Call this for questions about which roles convert offers best.",
  inputSchema: z.object({}),
  execute: () =>
    guard({ kind: "bar", x: "job", y: "rate", title: "Offer acceptance by job" }, async () => {
      const rows = await offerAcceptanceByJob(ctx);
      return ok(rows, { kind: "bar", x: "job", y: "rate", title: "Offer acceptance by job" });
    }),
}),
```

**3. Pick a `display` kind** (`bar` | `line` | `table`). The UI renders it
automatically from the hint. No UI changes needed.

**4. Add a benchmark** in `evals/copilot.eval.ts` (and, if it touches candidates, an assertion in `src/__tests__/guarantees.test.ts`).

That is the whole loop. You never write raw SQL in a tool, never touch the agent
loop, and never wire anything in the UI. The model picks the tool and fills params.

## Database: local vs production

`src/db/client.ts` chooses the driver:

- **Local dev / tests / evals:** in-process PGlite (file-backed in dev so `db:seed` and `next dev` share one DB; in-memory under vitest so parallel workers don't contend). Zero setup, no keys.
- **Production (Cloudflare Workers):** Neon serverless Postgres over HTTP, selected when `DATABASE_URL` is set. Both are Postgres, so the query layer, permissions, and evals are identical across the two.

Schema and tenant Row-Level Security live in `src/db/migrate.ts` (see DECISIONS for why RLS is a second layer under `scopeWhere`).

## Verification

- `pnpm test`: the guarantee suite (the CI gate; goes red on a real regression).
- `pnpm eval`: Evalite: tenant isolation, PII, and (with a real model) answer
  quality, with per-case traces in `pnpm eval:dev`.
- `pnpm typecheck` · `pnpm build` · `pnpm cf:deploy`.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests + evals on every push/PR.
