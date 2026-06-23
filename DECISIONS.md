# Decisions

This is my write-up for the ATS analytics copilot. I had about 4 hours, so I
focused on getting the two non negotiables right (tenant isolation and PII
permissions) and building a clean vertical slice around them. Notes below on what I built, why, what I cut, and what I'd do next.

## Overview

The copilot chats with one workspace's recruiting data, calls tools to answer
analytical questions, and renders the results as charts and tables. It runs
against a real model (Anthropic through a Cloudflare AI Gateway), and falls back
to the offline mock so the repo still boots and the deterministic evals run with
no key.

The whole thing hangs off one idea: both safety rules are enforced in the query
layer, not in the UI and not in the prompt. That way they hold no matter what the model does or what a user types.

## Architecture and key decisions

**Tenant scoping.** All scoping lives in one function, `scopeWhere(table, ctx,
extra)`, and every query takes `ctx` as its first argument. You literally can't
write a query without the workspace filter, because the function that runs it
won't compile without `ctx`. For the queries that join (applicationsByJob,
findCandidates) I pin both tenant tables to the workspace instead of trusting the foreign key to keep things local. It's a little redundant, but it means a join can never quietly widen the scope, and that's the bug I care most about avoiding.

**PII permissions.** I went with "the analyst's query can't even ask for PII"
rather than "fetch everything then strip it." `candidateSelection(ctx)` builds the SQL projection by asking `canReadColumn` per column, so for an analyst the
name/email/phone columns are never added to the SELECT. The database never returns them, so there's nothing to leak later. I picked this over redaction because redaction leaves PII sitting in memory and only takes one forgotten code path to go wrong.

I then took this one layer further, to compile time. `findCandidates` is generic on the caller's role and returns a role-narrowed `CandidateRow<R>`: for an analyst the PII keys are absent from the type itself, so `row.email` is a type error at the call site, not just empty at runtime. It's the static twin of `candidateSelection`, and both are driven by the same `canReadColumn` rule so they can't disagree. A small assert file proves it under `tsc` in CI, with a `@ts-expect-error` on each analyst PII access; if the type ever stops hiding PII, those directives go unused and the typecheck fails. So PII is now blocked three ways: the SQL never selects it, the type never exposes it, and the adversarial test proves a real analyst answer never carries it. I kept the headline numbers grounded for the same reason it matters here: an analytics product should never invent a figure.

**Row-Level Security (second layer).** `scopeWhere` is the app-layer guarantee; RLS is the database-layer backstop under it. The app reads as a restricted `app_user` role with a per-table policy that only returns rows for the workspace set in `app.workspace_id`, which `scoped()` sets per request (atomically with the query: a batch on neon-http, an interactive transaction on PGlite). So even a query that forgot `scopeWhere` would still only see one workspace's rows. A test proves it: a raw read with no `scopeWhere`, only the RLS key, still comes back single-tenant. The seed writes as the owner (which bypasses RLS) to load both tenants in one pass.

**Build-time import fence (third layer).** The two layers above stop a bad query at runtime; this one stops it from being written at all. A custom ESLint rule forbids importing the tenant table objects (candidates, applications, jobs, users) anywhere outside the data layer (`src/db/**`). To express a cross-tenant query you have to import a tenant table, and that import is now a lint error everywhere but `analytics.ts`, so the only place those tables can be queried is the layer that routes through `scopeWhere` and RLS. "You can't forget the workspace filter" is a build failure in CI, not a code-review comment. The `workspaces` directory table (no workspace_id, read across tenants for the switcher) is intentionally left un-fenced, and tests are exempt because the RLS-proof test deliberately does a raw read. One honest limit: it's path-based, so a re-export could slip past it. Nobody does that here, and RLS is still the backstop if they did. I verified the rule fires by adding a forbidden import and watching lint go red.

**Tools.** I added five small tools, one analytical question each:
applicationCountByStage (the reference), applicationsByJob, candidatesBySource,
applicationsOverTime, and findCandidates. They take typed Zod inputs with enums for the fixed choices (stage, source, time bucket), and the descriptions say when to call the tool, not just what it does, which helps the model pick the right one. None of them takes a workspaceId or role; those only come from server context. If a tool accepted a workspaceId, a crafted message could ask for someone else's data, and that's the worst case here. Each tool body is wrapped in a small `guard()` so a query failure comes back as a structured error the model can recover from instead of throwing into the stream.

**Generative UI.** Tool results carry a `display` hint (bar, line, or table) and
the chat page renders a component per kind as the agent streams. Each result can
also carry a headline metric (label, value, and an optional trend) that renders
as a stat card above the chart, for example "Total applications 24, down 33% vs
the prior week". The number is computed in the tool from the same rows it just
queried, never produced by the model, so it stays grounded and the trend only
shows when there's enough data to be honest about it. I built the bar
and line charts with plain CSS and a small inline SVG instead of pulling in a chart library. Less polished, but no dependency and easy to reason about. The table only renders the columns that are actually present, so an analyst's table just doesn't have PII columns in it. The copilot's prose is rendered with Streamdown (the streaming markdown renderer Vercel ships), so bold, lists, and the like render correctly even while tokens are still streaming in. The one wrinkle is that Streamdown's docs assume Tailwind 4, so on this Tailwind 3 project I import its prebuilt styles.css rather than the v4 @source directive. Worth noting: ai-elements' Response/MessageResponse component is just a thin wrapper around Streamdown. I used the package directly to avoid the shadcn + Tailwind 4 init the ai-elements CLI assumes.

A few touches to make it feel like a product rather than a one-shot demo. Bars are clickable: clicking a stage or source bar asks the matching follow-up ("show me the candidates in the interview stage"), which the model then routes to the right tool, so the chart becomes a way to navigate the data. After each answer I show two or three suggested next questions, picked from the tool that produced the answer. And the conversation persists to localStorage, scoped per workspace and role so the two tenants never share a transcript, and restores on reload. To avoid prop-drilling the chat's send through every chart and chip, a small React context provides it at the transcript root (and goes null while the agent is busy, which disables the controls).

**Visual design.** I used the shadcn-admin template as a visual reference, not a
dependency. It is a Vite + Tailwind 4 + Radix project, so adopting it wholesale
would have meant a risky migration; instead I lifted its design language (a
neutral oklch palette, Inter and Geist Mono, a 0.625rem radius, one blue accent)
into our Tailwind 3 setup as CSS tokens exposed as semantic colors
(bg-background, text-muted-foreground, border-border, and so on). That gives a
cohesive look, light and dark theming from one place, and a real app shell: a
sidebar with the workspace and role switchers plus a live pipeline, and a chat
column with user bubbles, an empty state with clickable prompts, and refined tool cards. I ran the web-design-guidelines skill over the result and fixed what it flagged: reduced-motion handling, a screen-reader status for the busy state, a theme-color meta, and a balanced heading.

## Model and agent

I'm running Anthropic through a Cloudflare AI Gateway. Anthropic because the job
is mostly tool routing rather than hard reasoning, and Claude drives typed tools
well, and it was already wired in the provider layer. The gateway because it gives me one place for observability, caching, and rate limiting without touching app code, and it keeps the upstream key off the client. The one gotcha worth noting: the AI SDK appends `/messages`, so the base URL has to end in `/anthropic/v1`, not just `/anthropic`. I default the model to claude-sonnet-4-6 since it's fast, cheap, and good at tool calls (so the evals stay cheap to run), and left claude-opus-4-8 as the option for the quality bar. There's also an optional gateway token for running the gateway in authenticated mode.

The loop itself is the given streamText setup capped at 6 steps. I kept the shape
and taught it a few behaviors through the system prompt, each backed by an eval:
it calls more than one tool when a question has separate parts (for example
"compare the pipeline to where candidates come from"); it asks one short
clarifying question instead of guessing when a question is ambiguous (for example
"how did that job do?" without saying which job); and it recovers from a tool
error rather than dumping it. That last one leans on the `guard()` wrapper: a
query failure comes back as a structured `{ error }` the model can act on instead
of throwing into the stream, so the turn still ends in a helpful answer. A
deterministic test proves the repair path (a tool that always fails still ends in
a final answer, no stack trace), and an eval proves the real model recovers.

## Benchmarks

Three evals, and they're built to actually fail if the thing they check breaks.

The tenant isolation eval uses the fact that the seed prefixes every id by
workspace (bw- and mer-). So a Brightwave answer that contains any mer- id is an
unambiguous leak. On top of that I assert every candidate id the copilot returns
is in Brightwave's real id set, which I read straight from the query layer as
admin. Remove scopeWhere and this goes red.

The PII eval runs the copilot as an analyst and checks two things: no row carries a name/email/phone key, and the prose contains no seeded email or phone. Make `canReadColumn` permissive and it fails.

The answer quality eval is an LLM judge and only runs against a real model, since the mock just returns canned text. It checks whether the answer addresses the question and stays consistent with the tool data.

I also pushed the evals past pass/fail into trajectory and cost. Beyond "did it answer," the trajectory eval grades whether the agent picked the tool I'd expect for each question, answered within a tight step budget, and stayed under a token ceiling (a cost regression gate I can tighten once there's a recorded baseline). The harness captures steps, tokens, and latency per case for this. And because the quality eval rests on an LLM judge, I added a judge-the-judge eval: a tiny golden set with known labels (one grounded answer that must score PASS, one fabricated answer that must score FAIL) so I can tell the judge actually discriminates rather than rubber-stamping. The model-dependent scorers are gated on a real provider so CI stays green offline; I verified the whole suite both ways, 23 of 23 at 100% on the mock and again against claude-sonnet-4-6.

One honest note on tooling: the repo pinned vitest 3 but evalite beta.16 is built for vitest 4, so its reporter crashed while rendering any failed test (it hid the real failure behind a stack trace). I bumped vitest to 4 and pinned pnpm 9 so the lockfile format held. That paid off immediately: the eval then actually caught a real bug, `applicationsOverTime` was failing Postgres's GROUP BY rule because I reused a parameter bearing date_trunc expression in both SELECT and GROUP BY. The `returnedData` scorer went to zero, I traced it, and fixed it to group by ordinal position. The reporter now renders pass and fail cleanly.

## Stretch: gateway caching and rate limiting

I did the gateway stretch from the README's optional list. Both caching and rate
limiting are gateway features, so most of the control lives on the gateway config and the app sends the per-request headers that drive them. Status: live and verified. The deployed app routes through an authenticated Cloudflare AI Gateway (`ats-copilot`) with caching and rate limiting enabled. A repeated identical `/api/chat` request dropped from about 7.2s to 1.1s, which is the gateway serving the upstream Anthropic calls from cache, and the requests show up in the gateway's Logs tab tagged with the per-tenant `workspaceId`/`role` metadata.

Caching: when AI_GATEWAY_CACHE_TTL is set, the provider sends `cf-aig-cache-ttl`
so our requests opt into the gateway cache, and AI_GATEWAY_SKIP_CACHE=true sends
`cf-aig-skip-cache` to bypass it (handy in a live demo so answers reflect fresh
data). The response carries `cf-aig-cache-status: HIT|MISS`.

Why caching is tenant safe here: the gateway keys the cache on the request body,
and the workspace id is never in that body. The only request two workspaces could share is the first "which tool should I call" step, which carries no workspace data and returns a workspace agnostic tool call. As soon as a tool result enters the conversation (the actual workspace data), the body diverges and the cache keys split per workspace, so caching can't serve one tenant another tenant's answer. The thing to watch is staleness within a workspace, which is why the TTL is configurable and skippable.

Rate limiting: set on the gateway (`rate_limiting_interval` + `rate_limiting_limit`). It is per gateway and returns 429 when exceeded, and the AI SDK already retries 429s with backoff. Since the built in limit is per gateway rather than per tenant, true per workspace limits would use dynamic routing. To keep that path open without app changes, every request is tagged `cf-aig-metadata: {workspaceId, role}`, which also segments the gateway's analytics and cache views per tenant.

## What I deliberately did NOT build (and why)

Knowing where to stop matters as much as what I shipped. Each of these was a
conscious no, not an oversight.

- **Auth.** Out of scope by design. Identity is mocked via headers, and the
  authorization I enforce off that context is identical whether it comes from a
  header or a verified session. Building login would spend the budget on the one
  part the brief explicitly stubs.
- **drizzle-kit migrations.** Raw idempotent DDL in `migrate.ts` keeps the repo
  zero-setup, with no migration step to run before the app boots. In a real
  project this would be a generated migration; here the simplicity is worth more
  than the ceremony.
- **A sixth tool.** The query-layer and tool pattern is proven by five tools and
  documented in ARCHITECTURE.md under "add a tool in 5 minutes". Another one adds
  surface, not signal.
- **Per-tenant rate limiting.** Cloudflare's gateway rate limit is per gateway.
  True per-workspace limits would use the gateway's dynamic routing keyed on the
  `cf-aig-metadata` I already send; I wired the metadata and stopped there rather
  than build routing I can't fully exercise in a take-home.
- **Pagination** in `findCandidates` (capped at 100). Correct at seed scale;
  cursor pagination is the obvious extension.

What I took past the bar earns its keep because it deepens the two things this
exercise is really probing, enforcement and agentic quality, rather than just
adding surface. On enforcement: the adversarial guarantee suite that runs in CI
and goes red the instant enforcement weakens, plus Row-Level Security, the
build-time import fence, and compile-time PII types, so each guarantee holds three
independent ways, and the live deploy behind the gateway. On agentic quality: the
grounded headline metric; an agent that fans out to multiple tools on compound
questions, asks before guessing on ambiguous ones, and recovers from a tool error;
eval maturity past pass/fail (trajectory, a cost gate, and a judge-the-judge
calibration check); and product touches that make it usable (clickable drill-down
from a chart, suggested follow-ups, and per-tenant conversation persistence).

The honest caveat: that is a lot, and "knows where to stop" is itself a signal.
I went wide here deliberately, to show range, but each piece is scoped and
defended rather than half-built, and the things I left out below are left out on
purpose.

With another day: per-workspace rate limiting through the gateway's dynamic
routing, cursor pagination in `findCandidates`, and generated drizzle-kit
migrations, all noted below.

## Deployment (Cloudflare Workers + Neon)

I'm deploying to Cloudflare Workers with OpenNext (`@opennextjs/cloudflare`),
which is Cloudflare's supported way to run Next.js now (Pages and next-on-pages
are legacy). It supports Next 16 and wants the Node runtime, which is already what `/api/chat` and tRPC use.

The database is the only thing that had to change. PGlite is file backed and can't run on Workers, so production uses Neon serverless Postgres over HTTP, which runs fine on workerd. The nice part is that both are Postgres, so `src/db/client.ts` is the only file that changes: it uses Neon when `DATABASE_URL` is set and PGlite otherwise. The two drivers load through dynamic imports so the unused one is never pulled in, which also keeps PGlite's wasm out of the Worker bundle (it is also marked external in next.config). `scopeWhere`, `candidateSelection`, every query, and the evals are untouched, and local dev, tests, and evals stay on zero setup PGlite.

Schema and seed: locally PGlite builds the schema lazily; on Neon I provision it
once by running the same seed against `DATABASE_URL` rather than creating tables
per request. The DDL is `CREATE TABLE IF NOT EXISTS`, so it is safe either way.

Config and secrets: `AI_PROVIDER` and `ANTHROPIC_MODEL` are non secret vars in
`wrangler.jsonc`; `ANTHROPIC_API_KEY` and `DATABASE_URL` are Worker secrets set
with `wrangler secret put`. The AI Gateway URL is optional for the first deploy,
since the provider falls back to direct Anthropic when it is unset, so I can ship a working URL first and route through the gateway (with its caching and rate limiting turned on) after.

Deploy steps: create the Neon DB and grab its connection string, seed it
(`DATABASE_URL=... pnpm db:seed`), `wrangler login`, set the two secrets, then
`pnpm cf:deploy`.

Live at https://ats-analytics-copilot.f-7a4.workers.dev. I verified both
non negotiables end to end on the Worker, not just locally: the tenant switcher
reads the two workspaces from Neon, an admin question runs `applicationCountByStage` and streams a grounded answer, and an analyst asking for names and emails gets de-identified rows with no PII in the response. It routes through the Cloudflare AI Gateway (`ats-copilot`, authenticated) with caching and rate limiting on, which I verified by the repeated-request latency drop described in the stretch section.

Keeping PGlite out of the Worker bundle took a deliberate trick. OpenNext
re-bundles the server function with its own esbuild pass and doesn't expose an
"externals" hook, so `serverExternalPackages` alone wasn't enough, and esbuild
followed the dynamic `import("@electric-sql/pglite")` and pulled the wasm in. The fix lives in `src/db/client.ts`: the driver is chosen with `if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL)` and the PGlite branch sits in the `else`. A production `next build` inlines `NODE_ENV`, so Turbopack dead-code-eliminates the PGlite branch before OpenNext's esbuild ever sees it. Verified the deployed bundle has no PGlite wasm (zero `ASM_CONSTS`, no `.wasm` files) while local dev, tests, and evals still use PGlite because they run
under `next dev`/vitest where `NODE_ENV` isn't production. A first attempt using a non-analyzable dynamic import worked for esbuild but broke Turbopack ("expression is too dynamic"), which is why the NODE_ENV gate is the right lever.

## Working with the agent

I leaned on the agent for the mechanical parts: reading the existing spine,
scaffolding the queries, tools, and UI, and wiring up the evals. I also had it
verify the Cloudflare base URL against the installed SDK instead of guessing the
path.

The decisions I drove or corrected: I chose the provider and the gateway, and I
chose the "can't select PII" approach over redaction. I insisted scoping stay one function taken as the first argument rather than scattered filters. I had it pin both tables on the joins instead of relying on the foreign key. And when a pnpm version mismatch tried to rewrite the whole lockfile, I threw that change away rather than commit the churn.

What I wouldn't hand off: where and how the isolation and PII guarantees are
enforced, and the model and provider choice. Those are the load bearing calls and I want to own them.

## Hours

Roughly 4 hours.
