/**
 * Role + column-permission model for the analytics copilot.
 *
 * The copilot serves users with different roles. Some columns are PII and must
 * not be readable by every role.
 *
 * ENFORCEMENT STRATEGY — "unrepresentable, not redacted".
 * Rather than selecting PII and stripping it before returning (which leaves PII
 * briefly in memory and is easy to forget on a new code path), the query layer
 * asks `canReadColumn` *while building the SQL projection*. For an `analyst`,
 * the PII columns are never added to the `select`, so the database never
 * returns them and the result type literally cannot carry them. This mirrors
 * the tenant-scoping philosophy of `scopeWhere` in `analytics.ts`: make the
 * unsafe query impossible to express, don't rely on a later cleanup step.
 */

export const ROLES = ["admin", "recruiter", "analyst"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Default role when none is supplied on the request. */
export const DEFAULT_ROLE: Role = "admin";

/** Columns considered PII, keyed by table. Reading these requires a non-analyst role. */
export const PII_COLUMNS: Record<string, readonly string[]> = {
  candidates: ["name", "email", "phone"],
};

/** Whether `table.column` is PII under the policy above. */
export function isPiiColumn(table: string, column: string): boolean {
  return PII_COLUMNS[table]?.includes(column) ?? false;
}

/**
 * Whether `role` may read `table.column`.
 *
 * The single rule: an `analyst` may not read PII columns; `recruiter` and
 * `admin` may read everything. Everything non-PII is readable by all roles.
 * The query layer consults this per-column when assembling a projection.
 */
export function canReadColumn(role: Role, table: string, column: string): boolean {
  if (role === "analyst" && isPiiColumn(table, column)) return false;
  return true;
}

/** Convenience: may this role read candidate PII at all? Used for tool hints/UX. */
export function canReadPii(role: Role): boolean {
  return role !== "analyst";
}
