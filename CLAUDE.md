# CLAUDE.md — AI Analytics Copilot (build exercise)

Guidance for AI coding assistants working in this repo. These instructions
OVERRIDE default behavior — follow them exactly.

## What this is

A multi-tenant B2B analytics copilot: it chats with one company's recruiting data
(jobs, candidates, applications), calls tools to answer analytical questions,
and renders the results as streaming charts/tables — scoped to ONE workspace at a
time. This is a ~4-hour build exercise judged on **judgment over completion**.

## The two non-negotiables (verified, never compromise)

1. **Tenant isolation.** Every read is scoped to one workspace. Workspace A must
   NEVER receive workspace B's rows.
2. **PII permissions.** An analyst must NEVER receive candidate PII (name / email
   / phone). A recruiter / admin may.

If a change risks either, stop and flag it. These two are the whole bar.

## Identity & context (read carefully)

- `workspaceId` and `role` arrive via the `x-workspace` / `x-role` request headers
  → the tRPC/agent context (`tenantFromHeaders` in `src/server/context.ts`). In
  production they'd come from the authenticated session. We ENFORCE off that
  context — we do NOT build auth.
- **`workspaceId` and `role` come from the server context ONLY.** They are never a
  tool argument, never supplied by the model, never read from the request body. A
  tool that accepts a `workspaceId` param is a cross-tenant breach waiting to happen.

## Core principles (how to build here)

- **Scope by construction, not by discipline.** Tenant scoping lives in one place:
  `scopeWhere(table, ctx, extra)` in `src/db/analytics.ts`. Every query takes `ctx`
  as its FIRST argument and routes its `WHERE` through `scopeWhere`, so a query
  can't be expressed without the workspace filter. Joins pin *both* tenant tables
  to the workspace (see `applicationsByJob` / `findCandidates`).
- **PII gating is "unrepresentable, not redacted."** `candidateSelection(ctx)` in
  `analytics.ts` builds the SQL projection from `canReadColumn` (`src/db/permissions.ts`).
  For an `analyst`, name/email/phone are never added to the `SELECT`, so results
  literally cannot carry PII — there is nothing to strip later. Same philosophy as
  `scopeWhere`: make the unsafe query impossible to write.
- **Design tools an LLM can drive.** Small, focused tools with prescriptive
  descriptions (say WHEN to call) and typed Zod inputs; `enum` for fixed choices
  (`STAGES`, `SOURCES`, `TIME_BUCKETS`). The model PICKS a tool and fills params —
  it NEVER writes SQL. Each tool returns `{ rows, display }` (`src/agent/artifact.ts`).
- **The agent loop.** `streamCopilot` in `src/agent/run.ts` runs `streamText` with
  `buildTools({workspaceId, role})`, capped at `stepCountIs(6)`. Tool bodies use a
  `guard()` wrapper that returns a structured `{ error }` result on failure instead
  of throwing, so the model can recover.
- **Wire a REAL model.** `getModel()` / `SYSTEM_PROMPT` in `src/agent/provider.ts`.
  This project uses **Anthropic routed through a Cloudflare AI Gateway**
  (`AI_PROVIDER=anthropic` + `AI_GATEWAY_BASE_URL=.../anthropic/v1`, optional
  `AI_GATEWAY_TOKEN`). The mock model only boots the repo / keeps tests deterministic.
- **Generative UI.** Turn tool results into real, streaming chart/table components
  in `src/app/page.tsx`, keyed off `display.kind` (`table` | `bar` | `line`).
- **Evals must catch what they claim.** Evalite `*.eval.ts` in `evals/`: a
  deterministic eval that a workspace-A question never returns B's rows (compare
  against trusted scoped data from `analytics.ts`); a deterministic eval that an
  analyst answer/tool-result never contains PII; and, with the real model wired, an
  LLM-as-judge eval for answer quality. An eval that can't fail is theater.

## The reference to mirror

`applicationCountByStage` (tool in `src/agent/tools.ts` → query in
`src/db/analytics.ts` → `display` hint the UI renders → benchmark in
`evals/copilot.eval.ts`) is the end-to-end template. Mirror its shape for every new
tool. Consistency with this pattern beats cleverness.

## Where things live

- `src/db/` — `schema.ts` + `seed.ts` + PGlite `client.ts`; `analytics.ts` (the
  scoped query layer — `scopeWhere`, `candidateSelection`, the query fns);
  `permissions.ts` (the PII rule — `canReadColumn`).
- `src/agent/` — `tools.ts` (catalog, `buildTools`) · `run.ts` (`streamCopilot`
  loop) · `provider.ts` (`getModel`, `SYSTEM_PROMPT`) · `artifact.ts` (`Display`,
  `ToolResult`) · `mock-model.ts`.
- `src/server/` — `trpc.ts` + `routers/app.ts` (router) + `context.ts` (carries
  `workspaceId` + `role`).
- `src/app/` — chat UI (`page.tsx`), providers, `/api/chat`, `/api/trpc`.
- `evals/` — Evalite `*.eval.ts`.

## Commands

> Requires Node ≥ 20.9 (Next.js 16). If `node -v` is older, switch first
> (e.g. `nvm use 22`).

- `pnpm install` · `pnpm db:seed` (wipe + seed two workspaces) · `pnpm dev`
- `pnpm eval` (run evals once) · `pnpm eval:dev` (watch + UI)
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `AI_PROVIDER` defaults to the offline mock — switch to `anthropic` (see
  `.env.example`) to build/demo the real agent.

## How to work with me

- **Explain every non-trivial decision in plain terms as you go.** The follow-up
  round is a live, AI-free session where I extend this code and defend trade-offs —
  I must OWN every decision. Don't build anything I can't narrate.
- **Ask sharp clarifying questions** instead of guessing on ambiguity.
- **Judgment over completion.** ~4-hour box. If we hit it, STOP and write up "what
  I'd do next" — running long isn't rewarded.

## Do / Don't

- ✅ Scope in the query layer; pass `workspaceId`/`role` only from context.
- ✅ Type tool inputs with Zod; return structured data + a display hint.
- ✅ Make evals that can actually fail on a real regression.
- ❌ Don't let the model write SQL or receive a `workspaceId` parameter.
- ❌ Don't gate PII in the UI only — gate it in the query projection.
- ❌ Don't build the copilot against the mock model.
- ❌ Don't over-build — ship the clean vertical slice, note the rest in DECISIONS.md.

## Deliverables

A PR with commits that tell a story; `DECISIONS.md` (trade-offs, what I cut + why,
what I'd do with another day, and a "Working with the agent" note); a ≤5-min Loom
(architecture + live demo). Keep this `CLAUDE.md` committed as the agent config.
