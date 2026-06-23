import { beforeAll, describe, expect, test } from "vitest";
import { tool, type UIMessage } from "ai";
import { z } from "zod";

import { db, ensureSchema } from "@/db/client";
import { workspaces } from "@/db/schema";
import { seed } from "@/db/seed";
import { guard } from "@/agent/tools";
import { streamCopilot } from "@/agent/run";

/**
 * The tool-error repair path. `guard()` turns a thrown query error into a
 * structured `{ error }` result instead of throwing into the stream, so the
 * model sees the failure and (per the system prompt) recovers rather than the
 * whole turn dying. These tests prove that deterministically with the mock
 * model: the guard converts the throw, and a failing tool still ends in a final
 * answer rather than an unhandled crash.
 */

function userMessage(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

type ResultOutput = { output?: { error?: string } };

beforeAll(async () => {
  await ensureSchema();
  if ((await db.select().from(workspaces)).length === 0) await seed();
});

describe("tool-call repair loop", () => {
  test("guard() converts a thrown error into a structured {error} result", async () => {
    const result = await guard({ kind: "table", columns: [] }, async () => {
      throw new Error("simulated query failure");
    });
    expect(result.error).toBe("simulated query failure");
    expect(result.rows).toEqual([]);
  });

  test("a failing tool does not crash the turn; the loop reaches a final answer", async () => {
    // Inject a catalog whose only tool always fails. The mock model calls it,
    // sees the guarded {error}, and proceeds to a closing message.
    const failingTools = {
      brokenQuery: tool({
        description: "Always fails — exercises the tool-error repair path.",
        inputSchema: z.object({}),
        execute: () =>
          guard({ kind: "table", columns: [] }, async () => {
            throw new Error("simulated query failure");
          }),
      }),
    };

    const result = await streamCopilot({
      workspaceId: "brightwave",
      role: "admin",
      messages: [userMessage("run the broken query")],
      tools: failingTools,
    });

    const [text, steps] = await Promise.all([result.text, result.steps]);
    const errors = steps
      .flatMap((s) => s.toolResults as ResultOutput[])
      .map((r) => r.output?.error)
      .filter(Boolean);

    // The error was captured as data (not thrown)...
    expect(errors).toContain("simulated query failure");
    // ...and the turn still produced a final answer instead of crashing.
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
