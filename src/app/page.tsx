"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ROLES } from "@/db/permissions";
import type { Display, Row } from "@/agent/artifact";
import {
  getActiveRole,
  getActiveWorkspace,
  useTenant,
  useTRPC,
} from "./providers";

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

  const { messages, sendMessage, status } = useChat({
    id: `${activeWorkspace}:${role}`,
    transport,
  });

  const [input, setInput] = useState("");
  const busy = status === "streaming" || status === "submitted";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <main className="mx-auto grid h-screen max-w-6xl grid-cols-[1fr_320px] gap-4 p-4">
      {/* Conversation column */}
      <section className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-balance text-lg font-semibold">
              ATS Analytics Copilot
            </h1>
            <p className="text-xs text-gray-500">
              Chat with this workspace&rsquo;s recruiting data.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500">Workspace</span>
              <select
                className="rounded border border-gray-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                value={activeWorkspace}
                onChange={(e) => setActiveWorkspace(e.target.value)}
              >
                {workspaces.data?.map((w) => (
                  <option key={w.id} value={w.slug}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500">Role</span>
              <select
                className="rounded border border-gray-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <div
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          {messages.length === 0 && (
            <p className="text-sm text-gray-400">
              Ask about this workspace &mdash; e.g. &ldquo;How does my pipeline
              look by stage?&rdquo; or &ldquo;Where are candidates coming
              from?&rdquo;
            </p>
          )}

          {messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <div key={message.id} className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  {isUser ? "You" : "Copilot"}
                </div>
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <p
                        key={i}
                        className={`whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm ${
                          isUser
                            ? "bg-gray-900 text-white"
                            : "bg-gray-50 text-gray-800"
                        }`}
                      >
                        {part.text}
                      </p>
                    );
                  }
                  if (part.type.startsWith("tool-")) {
                    return <ToolCall key={i} part={part} />;
                  }
                  return null;
                })}
              </div>
            );
          })}

          {busy && (
            <p role="status" className="text-xs text-gray-400">
              Copilot is working&hellip;
            </p>
          )}
        </div>

        <form
          onSubmit={submit}
          className="flex items-center gap-2 border-t border-gray-200 px-4 py-3"
        >
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            placeholder="Ask the analytics copilot…"
            aria-label="Message the analytics copilot"
            name="message"
            autoComplete="off"
            enterKeyHint="send"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </section>

      {/* Side panel: a reference scoped read via tRPC (pipeline by stage). */}
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold">Pipeline (this workspace)</h2>
          {pipeline.data && pipeline.data.length > 0 ? (
            <ul className="space-y-1">
              {pipeline.data.map((row) => (
                <li key={row.stage} className="flex justify-between text-xs">
                  <span className="font-medium">{row.stage}</span>
                  <span className="tabular-nums text-gray-400">
                    {Number(row.count)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-400">No data.</p>
          )}
        </div>
      </aside>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Tool-call rendering — generative UI.
//
// Each tool returns `{ rows, display }` where `display.kind` is
// "table" | "bar" | "line". We render a component per kind, show the
// calling → result transition, and handle empty/error states. The output
// arrives as the agent streams, so the card updates live.
// ---------------------------------------------------------------------------
type ToolOutput = { rows?: Row[]; display?: Display; error?: string };
type ToolPart = {
  type: string;
  state?: string;
  input?: unknown;
  output?: ToolOutput;
  errorText?: string;
};

function ToolCall({ part }: { part: unknown }) {
  const p = part as ToolPart;
  const name = p.type.replace(/^tool-/, "");
  const done = p.state === "output-available";
  // Either the framework errored the call, or our tool returned a structured error.
  const errored = p.state === "output-error" || Boolean(p.output?.error);
  const errorText = p.errorText ?? p.output?.error;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-xs shadow-sm">
      <div className="flex items-center gap-2 font-medium text-gray-700">
        {!done && !errored && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none"
          />
        )}
        <span className="font-mono">{name}</span>
        <span className="font-normal text-gray-400">
          {errored ? "· error" : done ? "· result" : "· calling…"}
        </span>
      </div>
      {errored && (
        <p className="mt-1.5 text-red-600">{errorText ?? "Tool call failed."}</p>
      )}
      {done && !errored && <Artifact output={p.output} />}
    </div>
  );
}

function Artifact({ output }: { output?: ToolOutput }) {
  const rows = output?.rows ?? [];
  const display = output?.display;
  if (rows.length === 0) {
    return <p className="mt-2 text-gray-400">No matching data.</p>;
  }
  if (display?.kind === "bar") return <BarChart rows={rows} display={display} />;
  if (display?.kind === "line") return <LineChart rows={rows} display={display} />;
  return <DataTable rows={rows} display={display} />;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function BarChart({
  rows,
  display,
}: {
  rows: Row[];
  display: Extract<Display, { kind: "bar" }>;
}) {
  const max = Math.max(1, ...rows.map((r) => toNum(r[display.y])));
  return (
    <figure className="mt-2 space-y-1.5">
      <figcaption className="mb-1 font-medium text-gray-600">
        {display.title}
      </figcaption>
      {rows.map((r, i) => {
        const value = toNum(r[display.y]);
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-right text-gray-500">
              {String(r[display.x] ?? "")}
            </span>
            <div className="flex h-4 flex-1 items-center">
              <div
                className="h-full rounded-sm bg-blue-500/80"
                style={{ width: `${(value / max) * 100}%` }}
              />
              <span className="ml-1.5 tabular-nums text-gray-600">{value}</span>
            </div>
          </div>
        );
      })}
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
  const pad = 4;
  const values = rows.map((r) => toNum(r[display.y]));
  const max = Math.max(1, ...values);
  const stepX = rows.length > 1 ? (W - pad * 2) / (rows.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (v / max) * (H - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <figure className="mt-2">
      <figcaption className="mb-1 font-medium text-gray-600">
        {display.title}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={display.title}
      >
        <polyline
          points={path}
          fill="none"
          stroke="rgb(59 130 246)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2} fill="rgb(59 130 246)" />
        ))}
      </svg>
      <div className="flex justify-between text-gray-400">
        <span>{String(rows[0]?.[display.x] ?? "")}</span>
        <span>peak {max}</span>
        <span>{String(rows[rows.length - 1]?.[display.x] ?? "")}</span>
      </div>
    </figure>
  );
}

function DataTable({
  rows,
  display,
}: {
  rows: Row[];
  display?: Display;
}) {
  const columns =
    display && display.kind === "table" && display.columns.length > 0
      ? display.columns
      : Object.keys(rows[0]);

  return (
    <table className="mt-2 w-full border-collapse text-left">
      <thead>
        <tr className="text-gray-400">
          {columns.map((c) => (
            <th key={c} className="border-b border-gray-100 py-1 pr-2 font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map((row, i) => (
          <tr key={i} className="text-gray-600">
            {columns.map((c) => (
              <td key={c} className="border-b border-gray-50 py-1 pr-2">
                {String(row[c] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
