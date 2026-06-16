# Product Engineer — Build Exercise

A small, runnable slice of what you'd build here: an **AI analytics copilot** that
chats with a team's recruiting data, calls tools to answer questions, and renders
the results — strictly scoped to **one workspace at a time**.

We care about **how you think and what you build**, not how much you finish.

---

## TL;DR

- **~4 focused hours**, anytime within 5 business days.
- **Boots with zero setup:** `pnpm install && pnpm db:seed && pnpm dev` runs on a
  built-in mock model — no keys needed just to start it.
- **You build a _real_ agent.** Wire it to a real model (any provider or gateway —
  your call); free options exist, or email us for a scoped key. The mock only
  exists so the repo boots and tests stay deterministic — it's not what you build
  your copilot against.
- **Use AI tools** (Claude Code, Cursor, Copilot…). We want to see how you drive an
  agent _and_ where you override it — commit your config.
- **Deliver:** a PR + `DECISIONS.md` + a ≤5-min Loom.
- If you hit the time box, **stop** and write up what you'd do next. Running long
  isn't rewarded.
- Questions welcome — **jobs@buildwithin.com**. Sharp clarifying questions are a
  positive signal here.

---

## The product

Multi-tenant B2B: a **workspace** is one company's applicant-tracking data — `jobs`,
`candidates`, `applications`. The copilot answers analytical questions
(_"how does my pipeline look by stage?"_, _"where are candidates coming from?"_) by
calling tools and rendering charts/tables. Two things are non-negotiable:

1. **Tenant isolation.** Every read is scoped to one workspace. Workspace A must
   **never** see B's data.
2. **Permissions.** Candidate PII (name / email / phone) is gated by role — an
   `analyst` never sees it; a `recruiter`/`admin` may.

The repo seeds **two workspaces** (`Brightwave`, `Meridian Logistics`) with distinct
data, and a `role` switcher, so both are testable, not hypothetical.

> **Identity is mocked.** `workspaceId` and `role` come from request headers set by
> the switchers; in production they'd come from the authenticated session (we use
> better-auth). You're enforcing access off that context — not building auth.

---

## What's given vs. what you build

This repo is a **thin vertical slice, not a finished app**. We've wired the plumbing
so you spend your time on the parts that matter.

**Given (the spine):**

- Postgres schema + seed, in-process via PGlite — no Docker, no cloud.
- The streaming agent loop (Vercel AI SDK) and a provider layer — `anthropic` /
  `openai` / `bedrock` + a gateway `baseURL`. A built-in mock model boots the repo
  and keeps tests deterministic; it's a stand-in, not the agent you build.
- A minimal chat UI (streams tokens; switches workspace + role) and a typed tRPC
  data layer.
- **One worked example, end to end:** the `applicationCountByStage` tool → a scoped
  query (`scopeWhere`) → a `display` hint the UI renders → a passing benchmark.
  **Use it as your template.**

**You build:**

- **A real agent.** Build the copilot against a real model — pick a provider or
  gateway, wire it, and justify the choice in `DECISIONS.md`. The mock just boots
  the repo; your demo should show the real thing.
- **The tool catalog.** Design the tools this copilot needs — which tools, their
  granularity, how their inputs are shaped for a model to fill, what each returns.
  The agent picks tools and passes params; **it never writes SQL.**
- **The query layer** behind them — composable and scoped. Make tenant scoping
  _impossible to forget_ as the layer grows.
- **Permissions.** Enforce the PII rule by role (`src/db/permissions.ts` is a stub).
- **The generative UI.** Turn tool results into real, streaming chart/table
  components (the current render is a bare stub).
- **Benchmarks.** Evals run on [Evalite](https://v1.evalite.dev) (`*.eval.ts`,
  zero-setup in-memory). `evals/copilot.eval.ts` is a worked example; add real evals
  for tenant isolation, permissions, and — once a real model is wired — answer
  quality. They must catch the thing they claim to.

---

## Requirements vs. goals

**Hard requirements** (we verify these):

- No tool ever returns another workspace's rows.
- An `analyst` never receives candidate PII.

**Quality bar** (this is the craft we're reading):

- Tool + query design that's clean and that an LLM can actually drive well.
- A chat + generative UI you'd be happy to ship.
- Benchmarks that test something real.

---

## Stretch — optional, pick at most one

A short written plan in `DECISIONS.md` counts as much as code here.

- **Deploy it live** (Cloudflare / Vercel / Railway / Fly / AWS). PGlite is
  file-backed and won't survive serverless — say where the DB lives, and justify
  the host.
- **One of:** a typed structured answer the agent emits, resumable streams, response
  caching, or rate limiting — pick one and justify it.

---

## Commands

```bash
pnpm install
pnpm db:seed      # wipe + seed the two workspaces (in-process Postgres)
pnpm dev          # http://localhost:3000
pnpm eval         # run agent evals once (Evalite)
pnpm eval:dev     # Evalite watch mode + local UI (traces per test case)
pnpm typecheck
pnpm test
pnpm build
```

`AI_PROVIDER` defaults to the offline **mock** so the repo boots with no keys. To
build the agent, switch it to a real provider or gateway — see `.env.example`.

---

## Where things live

```
src/
  db/        schema + seed + PGlite client; analytics.ts (the query layer — 1 reference fn); permissions.ts
  agent/     tools.ts (1 reference tool) · run.ts (the loop) · provider.ts · mock-model.ts · artifact.ts
  server/    tRPC router + context (carries workspaceId + role)
  app/       chat UI, providers, /api/chat, /api/trpc
evals/       agent evals — Evalite *.eval.ts (pnpm eval)
```

Stack: Next.js 16 (App Router) · React 19 · Vercel AI SDK v6 · tRPC v11 +
TanStack Query · Drizzle over PGlite · Evalite (evals) · Tailwind · TypeScript strict.

---

## Using AI tools

**Use them** — this is how we work. Two asks:

1. **Commit your agent config** (`CLAUDE.md` / `.cursorrules` / prompt files).
2. Add a short **"Working with the agent"** note to `DECISIONS.md`: what you
   delegated, where it was wrong and you caught it, what you'd never let it decide.

The follow-up technical conversation is a **live, AI-free working session** — we'll
extend this code together and talk trade-offs. Lean on AI to move fast here, but
own every decision in your submission.

---

## Deliverables

1. **A pull request** with commits that tell a story.
2. **`DECISIONS.md`** — trade-offs, what you cut and why, what you'd do with another
   day, the "Working with the agent" note.
3. **A ≤5-min Loom** — architecture + a live demo. This is the artifact we dig into
   next round.

---

## How we evaluate

Judgment over completion:

- **Agent integration** — did you wire a real model sensibly (provider/gateway
  choice, loop control, tool errors)?
- **Tool & query architecture** — is the surface well-designed for a model to drive?
  is data access clean and scoped _by construction_?
- **Tenant + permission correctness** — right, and right by construction.
- **Benchmarks** — do they catch what they claim?
- **UI / product taste** — a copilot you'd actually want to use.
- **Communication** — does your write-up make the trade-offs legible?

Have fun with it — this is a real slice of what we do.
