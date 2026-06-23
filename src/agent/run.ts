import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";

import { ensureSchema } from "@/db/client";
import type { Role } from "@/db/permissions";
import { env } from "@/env";
import { buildTools } from "./tools";
import { getModel, SYSTEM_PROMPT } from "./provider";

/**
 * Runs the analytics copilot for one turn and RETURNS the `streamText` result.
 *
 * The caller decides what to do with it:
 *   - the chat route calls `.toUIMessageStreamResponse()`
 *   - evals/tests `await result.steps` / `.toolCalls` / `.text`
 *
 * The agent loops (orient → query → answer) up to 6 steps via `stopWhen`.
 */
export async function streamCopilot({
  workspaceId,
  role,
  messages,
  model = getModel(),
}: {
  workspaceId: string;
  role: Role;
  messages: UIMessage[];
  /** Override the model — e.g. wrap it with evalite's wrapAISDKModel in evals. */
  model?: LanguageModel;
}) {
  await ensureSchema();

  // This is a minimal loop: one model, the tools, capped at 6 steps. Owning the
  // loop is part of the exercise — consider tool-error handling, your stop
  // strategy, and whether the agent should emit a typed structured answer.
  return streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: buildTools({ workspaceId, role }),
    stopWhen: stepCountIs(6),
    // Tag each request with the tenant so the gateway's analytics, caching, and
    // rate-limit views can be segmented per workspace/role. Gateway-only; the
    // header is meaningless (and unset) when calling Anthropic directly.
    headers: env.AI_GATEWAY_BASE_URL
      ? { "cf-aig-metadata": JSON.stringify({ workspaceId, role }) }
      : undefined,
  });
}
