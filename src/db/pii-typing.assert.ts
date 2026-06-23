/**
 * Compile-time proof of the PII type gate — the third enforcement layer.
 *
 * This file is NEVER executed. It exists to be type-checked by `pnpm typecheck`
 * (`tsc --noEmit`) in CI. Each `@ts-expect-error` asserts that a forbidden PII
 * access is a *type error*. If the role-narrowed `CandidateRow` ever stops
 * hiding PII from an analyst, those accesses stop erroring, the directives
 * become unused, and `tsc` fails — so weakening the gate turns CI red, the same
 * way the runtime adversarial test in `guarantees.test.ts` does.
 *
 * PII is now enforced three ways: the SQL projection never selects it
 * (`candidateSelection`), the row type never exposes it (here), and the
 * adversarial test proves a real analyst answer never carries it.
 */
import { findCandidates } from "./analytics";

// Instantiate the generic at concrete roles, then read back the element type.
const findForAnalyst = findCandidates<"analyst">;
const findForRecruiter = findCandidates<"recruiter">;

type AnalystRow = Awaited<ReturnType<typeof findForAnalyst>>[number];
type RecruiterRow = Awaited<ReturnType<typeof findForRecruiter>>[number];

declare const analystRow: AnalystRow;
declare const recruiterRow: RecruiterRow;

// Non-PII columns are present for every role.
export function nonPiiIsReadable() {
  return [analystRow.id, analystRow.source, analystRow.createdAt];
}

// PII is absent from an analyst's row TYPE — the access can't be written.
export function analystPiiIsATypeError() {
  return [
    // @ts-expect-error analyst rows have no `name`
    analystRow.name,
    // @ts-expect-error analyst rows have no `email`
    analystRow.email,
    // @ts-expect-error analyst rows have no `phone`
    analystRow.phone,
  ];
}

// A recruiter's row type DOES carry PII (the rule is role-gated, not off).
export function recruiterPiiIsReadable() {
  return [recruiterRow.name, recruiterRow.email, recruiterRow.phone];
}
