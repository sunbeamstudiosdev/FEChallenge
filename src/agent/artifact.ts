/**
 * The "generative UI" contract. Every agent tool returns rows plus a `display`
 * hint telling the UI how to render them (a table or a chart). The chat page
 * renders a component per tool result as the agent streams — see
 * src/app/page.tsx.
 */

export type Row = Record<string, unknown>;

export type Display =
  | { kind: "table"; columns: string[] }
  | { kind: "bar"; x: string; y: string; title: string }
  | { kind: "line"; x: string; y: string; title: string };

export type ToolResult = {
  rows: Row[];
  display: Display;
  /**
   * Set when a tool failed. The agent loop sees this in the tool result and can
   * recover (retry with different params, or explain) instead of the call
   * throwing into the void. The UI renders it as an error state.
   */
  error?: string;
};
