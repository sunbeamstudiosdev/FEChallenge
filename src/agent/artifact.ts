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

/**
 * Optional one-line "headline metric" the UI renders as a stat card above the
 * chart. It is DERIVED FROM THE ROWS by the tool (a sum, a count, a period-over-
 * period delta) — never supplied by the model — so the number is grounded in the
 * same query result, with no chance of a hallucinated figure. `trend` is only
 * present where it's meaningful (time series).
 */
export type Trend = {
  direction: "up" | "down" | "flat";
  /** Human-readable, e.g. "+18% vs the prior week". */
  label: string;
};
export type Headline = {
  label: string;
  value: string;
  trend?: Trend;
};

export type ToolResult = {
  rows: Row[];
  display: Display;
  /** Grounded summary stat for the stat card; see `Headline`. */
  headline?: Headline;
  /**
   * Set when a tool failed. The agent loop sees this in the tool result and can
   * recover (retry with different params, or explain) instead of the call
   * throwing into the void. The UI renders it as an error state.
   */
  error?: string;
};
