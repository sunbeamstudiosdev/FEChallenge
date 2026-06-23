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

**Agent behavior** lives in the system prompt (`src/agent/provider.ts`), each backed by an eval: fan out to multiple tools on a compound question, ask one clarifying question instead of guessing when a question is ambiguous, and recover from a tool error. Recovery rests on `guard()` in `tools.ts`, which turns a thrown query error into a structured `{ error }` the model can act on instead of throwing into the stream.

**Product touches** in `page.tsx`: chart bars are clickable (they ask a contextual follow-up the model routes to the right tool), suggested follow-ups appear under each answer, and the conversation persists to localStorage scoped per workspace+role. A small React context provides the chat's `send` to deep components instead of prop-drilling.

## The two guarantees, in code

**Tenant scope: `scopeWhere(table, ctx, extra)` in `src/db/analytics.ts`.**
Every query takes `ctx` as its first argument and routes its `WHERE` through
`scopeWhere`, which AND-s `workspace_id = ctx.workspaceId` into the filter. You
cannot express a query without the tenant scope. Joins pin *both* tenant tables to the workspace (see `applicationsByJob`, `findCandidates`). This is enforced three ways: `scopeWhere` at the app layer, RLS at the database layer (`migrate.ts`), and a build-time ESLint fence (`eslint.config.mjs`) that makes importing a tenant table outside `src/db/**` a lint error, so a cross-tenant query can't be written elsewhere in the first place.

**PII: `candidateSelection(ctx)` in `src/db/analytics.ts`.**
It builds the candidate column projection from `canReadColumn` (`src/db/permissions.ts`). For an analyst, name/email/phone are never added to the `SELECT`, so the database never returns them. PII is unrepresentable in the result, not stripped afterward. It is also gated at compile time: `findCandidates` returns a role-narrowed `CandidateRow<R>`, so `row.email` is a *type error* for an analyst (proven by `src/db/pii-typing.assert.ts` under `tsc` in CI). SQL omits it, the type hides it, and the adversarial test proves a real answer never carries it.

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
automatically from the hint. No UI changes needed. Optionally pass a third
argument to `ok(...)`, a headline `{ label, value, trend? }` derived from the
rows, and the UI shows it as a stat card above the chart (compute it in the tool,
never let the model supply the number).

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
- `pnpm lint`: includes the tenant-table import fence (fails the build if a
  tenant table is imported outside the data layer).
- `pnpm typecheck`: includes `pii-typing.assert.ts` (fails if an analyst row type
  ever exposes PII).
- `pnpm eval`: Evalite: tenant isolation, PII, answer quality, plus trajectory
  (right tool + step budget + token ceiling), compound fan-out, clarifying turn,
  tool-error recovery, and a judge-the-judge calibration check. Model-dependent
  scorers are gated on a real provider so CI stays green offline; per-case traces
  in `pnpm eval:dev`.
- `pnpm build` · `pnpm cf:deploy`.
- CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests + evals on every push/PR.
