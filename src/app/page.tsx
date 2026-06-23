"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { ROLES } from "@/db/permissions";
import type { Display, Headline, Row } from "@/agent/artifact";
import {
  getActiveRole,
  getActiveWorkspace,
  useTenant,
  useTRPC,
} from "./providers";

const EXAMPLE_PROMPTS = [
  "How does my pipeline look by stage?",
  "Where are candidates coming from?",
  "Which jobs have the most applications?",
  "How have applications trended over time?",
];

/**
 * Lets deep components (a clickable chart bar, a follow-up chip) send a
 * follow-up question without prop-drilling the chat's `send` through every
 * layer. Provided once at the transcript root.
 */
const AskContext = createContext<((text: string) => void) | null>(null);
const useAsk = () => useContext(AskContext);

/** Contextual next questions, keyed on the tool that produced the last answer. */
const FOLLOW_UPS: Record<string, string[]> = {
  applicationCountByStage: [
    "Which jobs have the most applications?",
    "How have applications trended over time?",
  ],
  applicationsByJob: [
    "How does my pipeline look by stage?",
    "Where are candidates coming from?",
  ],
  candidatesBySource: [
    "Which jobs have the most applications?",
    "How have applications trended over time?",
  ],
  applicationsOverTime: [
    "How does my pipeline look by stage?",
    "Which jobs have the most applications?",
  ],
  findCandidates: [
    "How does my pipeline look by stage?",
    "Where are candidates coming from?",
  ],
};

/** Suggested follow-ups for the latest assistant turn (deduped, capped at 3). */
function suggestionsFor(message: ChatMessage | undefined): string[] {
  if (!message || message.role !== "assistant") return [];
  const tools = message.parts
    .filter((p) => p.type.startsWith("tool-"))
    .map((p) => p.type.replace(/^tool-/, ""));
  const out: string[] = [];
  for (const t of tools) for (const q of FOLLOW_UPS[t] ?? []) if (!out.includes(q)) out.push(q);
  return out.slice(0, 3);
}

export default function Page() {
  const { activeWorkspace, setActiveWorkspace, role, setRole } = useTenant();
  const trpc = useTRPC();

  const workspaces = useQuery(trpc.workspaces.list.queryOptions());
  const pipeline = useQuery(trpc.analytics.applicationsByStage.queryOptions({}));

  // A fresh transport per active workspace/role so the `x-workspace` + `x-role`
  // headers follow the switchers. Keying useChat on them also resets the
  // conversation when you switch tenant or role.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => ({
          "x-workspace": getActiveWorkspace(),
          "x-role": getActiveRole(),
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkspace, role],
  );

  const { messages, sendMessage, setMessages, status } = useChat({
    id: `${activeWorkspace}:${role}`,
    transport,
  });

  const [input, setInput] = useState("");
  const busy = status === "streaming" || status === "submitted";

  // Conversation persistence, scoped per workspace+role so switching tenants
  // keeps each conversation separate (and never crosses them). One effect:
  // on a key change restore that conversation from localStorage; otherwise
  // persist the current messages. The ref starts null so the first run always
  // restores (instead of clobbering storage with the empty initial state).
  const storageKey = `chat:${activeWorkspace}:${role}`;
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loadedKey.current !== storageKey) {
      loadedKey.current = storageKey;
      try {
        const raw = localStorage.getItem(storageKey);
        setMessages(raw ? JSON.parse(raw) : []);
      } catch {
        setMessages([]);
      }
      return; // don't persist on the restore pass
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages));
    } catch {
      // ignore quota / serialization errors; persistence is best-effort
    }
  }, [messages, storageKey, setMessages]);

  // Auto-scroll the transcript to the latest content as it streams.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const workspaceName =
    workspaces.data?.find((w) => w.slug === activeWorkspace)?.name ??
    activeWorkspace;

  function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput("");
  }

  return (
    <div className="grid h-screen grid-cols-[280px_1fr] bg-background text-foreground">
      <Sidebar
        workspaces={workspaces.data ?? []}
        activeWorkspace={activeWorkspace}
        setActiveWorkspace={setActiveWorkspace}
        role={role}
        setRole={setRole}
        pipeline={pipeline.data ?? []}
      />

      <main className="flex min-h-0 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-border px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-sm font-semibold">{workspaceName}</h1>
            <RoleBadge role={role} />
          </div>
          <span className="text-xs text-muted-foreground">
            Analytics copilot
          </span>
        </header>

        {/* Transcript */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto scroll-smooth px-6 py-6"
          aria-live="polite"
        >
          <AskContext.Provider value={busy ? null : send}>
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
              {messages.length === 0 ? (
                <EmptyState onPick={send} disabled={busy} />
              ) : (
                messages.map((message) => (
                  <MessageRow key={message.id} message={message as ChatMessage} />
                ))
              )}
              {busy && <Thinking />}
              {!busy && <Suggestions message={messages[messages.length - 1] as ChatMessage} />}
            </div>
          </AskContext.Provider>
        </div>

        {/* Composer */}
        <div className="border-t border-border px-6 py-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border border-input bg-card px-2 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring"
          >
            <input
              className="flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
              placeholder={`Ask about ${workspaceName}'s recruiting data…`}
              aria-label="Message the analytics copilot"
              name="message"
              autoComplete="off"
              enterKeyHint="send"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send message"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <SendIcon />
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">
            Scoped to one workspace. Analysts never receive candidate PII.
          </p>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
type Workspace = { id: string; slug: string; name: string };

function Sidebar({
  workspaces,
  activeWorkspace,
  setActiveWorkspace,
  role,
  setRole,
  pipeline,
}: {
  workspaces: Workspace[];
  activeWorkspace: string;
  setActiveWorkspace: (v: string) => void;
  role: string;
  setRole: (v: (typeof ROLES)[number]) => void;
  pipeline: Array<{ stage: string; count: number | string }>;
}) {
  return (
    <aside className="flex min-h-0 flex-col gap-6 border-r border-border bg-card px-4 py-5">
      <div className="flex items-center gap-2.5 px-1">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <SparkIcon />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">ATS Copilot</div>
          <div className="text-[11px] text-muted-foreground">
            Recruiting analytics
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Field label="Workspace">
          <Select
            value={activeWorkspace}
            onChange={(e) => setActiveWorkspace(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.slug}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Live pipeline for the active workspace (scoped tRPC read) */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-xs font-semibold">Pipeline</h2>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            by stage
          </span>
        </div>
        {pipeline.length > 0 ? (
          <ul className="space-y-2">
            {pipeline.map((row) => {
              const max = Math.max(
                1,
                ...pipeline.map((r) => Number(r.count)),
              );
              const val = Number(row.count);
              return (
                <li key={row.stage} className="text-xs">
                  <div className="mb-1 flex justify-between">
                    <span className="capitalize text-foreground">
                      {row.stage}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {val}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${(val / max) * 100}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No data.</p>
        )}
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] text-muted-foreground">Theme</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        <ChevronIcon />
      </span>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
type ChatMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string } & Record<string, unknown>>;
};

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  if (isUser) {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
        <SparkIcon />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div key={i} className="text-sm leading-relaxed text-foreground">
                <Streamdown>{part.text ?? ""}</Streamdown>
              </div>
            );
          }
          if (part.type.startsWith("tool-")) {
            return <ToolCall key={i} part={part} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (t: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent">
        <SparkIcon large />
      </span>
      <div className="space-y-1">
        <h2 className="text-balance text-base font-semibold">
          Ask about your recruiting data
        </h2>
        <p className="text-sm text-muted-foreground">
          The copilot queries this workspace and renders charts and tables.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onPick(p)}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
        <SparkIcon />
      </span>
      <div className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
      <span role="status" className="sr-only">
        Copilot is working
      </span>
    </div>
  );
}

/** Contextual "ask next" chips under the latest answer. */
function Suggestions({ message }: { message: ChatMessage | undefined }) {
  const ask = useAsk();
  const suggestions = suggestionsFor(message);
  if (!ask || suggestions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pl-10" aria-label="Suggested follow-ups">
      {suggestions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => ask(q)}
          className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool-call rendering — generative UI keyed on `display.kind`.
// ---------------------------------------------------------------------------
type ToolOutput = {
  rows?: Row[];
  display?: Display;
  headline?: Headline;
  error?: string;
};
type ToolPart = {
  type: string;
  state?: string;
  output?: ToolOutput;
  errorText?: string;
};

function ToolCall({ part }: { part: unknown }) {
  const p = part as ToolPart;
  const name = p.type.replace(/^tool-/, "");
  const done = p.state === "output-available";
  const errored = p.state === "output-error" || Boolean(p.output?.error);
  const errorText = p.errorText ?? p.output?.error;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {!done && !errored && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        )}
        <span className="font-mono font-medium text-foreground">{name}</span>
        <span className="text-muted-foreground">
          {errored ? "error" : done ? "result" : "running…"}
        </span>
      </div>
      <div className="px-3 py-3">
        {errored ? (
          <p className="text-xs text-destructive">
            {errorText ?? "Tool call failed."}
          </p>
        ) : done ? (
          <Artifact output={p.output} />
        ) : null}
      </div>
    </div>
  );
}

function Artifact({ output }: { output?: ToolOutput }) {
  const rows = output?.rows ?? [];
  const display = output?.display;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No matching data.</p>;
  }
  return (
    <div className="space-y-3">
      {output?.headline && <HeadlineCard headline={output.headline} />}
      {display?.kind === "bar" ? (
        <BarChart rows={rows} display={display} />
      ) : display?.kind === "line" ? (
        <LineChart rows={rows} display={display} />
      ) : (
        <DataTable rows={rows} display={display} />
      )}
    </div>
  );
}

/** Grounded "headline metric" stat card rendered above the chart. */
function HeadlineCard({ headline }: { headline: Headline }) {
  const { label, value, trend } = headline;
  const trendColor =
    trend?.direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : trend?.direction === "down"
        ? "text-destructive"
        : "text-muted-foreground";
  const arrow =
    trend?.direction === "up" ? "↑" : trend?.direction === "down" ? "↓" : "→";
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </span>
        {trend && (
          <span className={`text-xs font-medium ${trendColor}`}>
            {arrow} {trend.label}
          </span>
        )}
      </div>
    </div>
  );
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Turn a clicked bar category into a useful follow-up question. */
function drillPrompt(dimension: string, label: string): string {
  switch (dimension) {
    case "stage":
      return `Show me the candidates in the ${label} stage.`;
    case "source":
      return `Show me the candidates from ${label}.`;
    case "job":
      return `How is the ${label} role doing across stages?`;
    default:
      return `Tell me more about ${label}.`;
  }
}

function BarChart({
  rows,
  display,
}: {
  rows: Row[];
  display: Extract<Display, { kind: "bar" }>;
}) {
  const ask = useAsk();
  const max = Math.max(1, ...rows.map((r) => toNum(r[display.y])));
  return (
    <figure className="space-y-2">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {display.title}
        {ask && (
          <span className="ml-2 font-normal normal-case text-muted-foreground/70">
            (click a bar to dig in)
          </span>
        )}
      </figcaption>
      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const value = toNum(r[display.y]);
          const label = String(r[display.x] ?? "");
          const bar = (
            <>
              <span className="w-28 shrink-0 truncate text-right capitalize text-muted-foreground">
                {label}
              </span>
              <div className="flex h-5 flex-1 items-center gap-1.5">
                <div
                  className="h-full min-w-[2px] rounded-md bg-accent"
                  style={{ width: `${(value / max) * 100}%` }}
                />
                <span className="tabular-nums text-foreground">{value}</span>
              </div>
            </>
          );
          return ask ? (
            <button
              key={i}
              type="button"
              onClick={() => ask(drillPrompt(display.x, label))}
              title={`Ask a follow-up about ${label}`}
              className="flex w-full items-center gap-2 rounded-sm text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {bar}
            </button>
          ) : (
            <div key={i} className="flex items-center gap-2 text-xs">
              {bar}
            </div>
          );
        })}
      </div>
    </figure>
  );
}

function LineChart({
  rows,
  display,
}: {
  rows: Row[];
  display: Extract<Display, { kind: "line" }>;
}) {
  const W = 320;
  const H = 80;
  const pad = 6;
  const values = rows.map((r) => toNum(r[display.y]));
  const max = Math.max(1, ...values);
  const stepX = rows.length > 1 ? (W - pad * 2) / (rows.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (v / max) * (H - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `${pad},${H - pad} ${path} ${pad + (rows.length - 1) * stepX},${H - pad}`;

  return (
    <figure className="space-y-2">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {display.title}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={display.title}
      >
        <polygon points={area} fill="var(--accent-soft)" />
        <polyline
          points={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.5} fill="var(--accent)" />
        ))}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{String(rows[0]?.[display.x] ?? "")}</span>
        <span>peak {max}</span>
        <span>{String(rows[rows.length - 1]?.[display.x] ?? "")}</span>
      </div>
    </figure>
  );
}

function DataTable({ rows, display }: { rows: Row[]; display?: Display }) {
  const columns =
    display && display.kind === "table" && display.columns.length > 0
      ? display.columns
      : Object.keys(rows[0]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c}
                className="border-b border-border py-1.5 pr-3 font-medium capitalize"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((row, i) => (
            <tr key={i} className="text-foreground">
              {columns.map((c) => (
                <td
                  key={c}
                  className="border-b border-border/60 py-1.5 pr-3 tabular-nums"
                >
                  {String(row[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const isDark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    // Intentional post-mount setState: the server can't read localStorage /
    // matchMedia, so reading the theme after hydration is what AVOIDS a
    // hydration mismatch. This is the correct place for it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons (inline, no dependency)
// ---------------------------------------------------------------------------
function SparkIcon({ large }: { large?: boolean }) {
  const s = large ? 22 : 15;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4L12 3z"
        fill="currentColor"
      />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12l16-8-6 16-3-7-7-1z"
        fill="currentColor"
      />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx={12} cy={12} r={4} stroke="currentColor" strokeWidth={2} />
      <path
        d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}
