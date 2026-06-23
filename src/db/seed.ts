import { db } from "./client";
import { runMigrations } from "./migrate";
import {
  applications,
  candidates,
  jobs,
  users,
  workspaces,
  type NewApplication,
  type NewCandidate,
  type NewJob,
  type NewUser,
  type NewWorkspace,
} from "./schema";

/**
 * Seed two workspaces (tenant companies) with overlapping-but-distinct ATS
 * data, so tenant isolation and role permissions are testable, not
 * hypothetical. Fully deterministic (no randomness) so analytics have exact,
 * reproducible ground truth for benchmarking. Idempotent: wipes the tables
 * then re-inserts from these fixtures.
 */

const SOURCES = [
  "referral",
  "linkedin",
  "job_board",
  "agency",
  "careers_site",
] as const;

const STAGES = [
  "applied",
  "screen",
  "interview",
  "offer",
  "hired",
  "rejected",
] as const;

const FIRST = [
  "Robin", "Sam", "Jordan", "Priya", "Alex", "Taylor", "Jamie", "Casey",
  "Morgan", "Avery", "Quinn", "Riley", "Drew", "Sky", "Reese", "Harper",
  "Rowan", "Sage", "Blake", "Emerson",
];
const LAST = [
  "Vega", "Okafor", "Nair", "Lee", "Kim", "Patel", "Garcia", "Chen",
  "Khan", "Silva", "Brooks", "Lopez", "Ito", "Ali", "Diaz", "Ross",
  "Wong", "Singh", "Hayes", "Cole",
];

type JobDef = [title: string, department: string, location: string, status: string];
type UserDef = [name: string, email: string, role: string];

type WorkspaceDef = {
  id: string;
  slug: string;
  name: string;
  prefix: string;
  users: UserDef[];
  jobs: JobDef[];
  candidateCount: number;
};

const WORKSPACES: WorkspaceDef[] = [
  {
    id: "brightwave",
    slug: "brightwave",
    name: "Brightwave",
    prefix: "bw",
    users: [
      ["Ada Admin", "ada@brightwave.example", "admin"],
      ["Riley Recruiter", "riley@brightwave.example", "recruiter"],
      ["Ana Analyst", "ana@brightwave.example", "analyst"],
    ],
    jobs: [
      ["Senior Software Engineer", "Engineering", "Remote", "open"],
      ["Product Designer", "Design", "New York", "open"],
      ["Data Analyst", "Data", "Remote", "open"],
      ["Technical Recruiter", "People", "San Francisco", "closed"],
      ["Account Executive", "Sales", "Austin", "draft"],
    ],
    candidateCount: 18,
  },
  {
    id: "meridian",
    slug: "meridian",
    name: "Meridian Logistics",
    prefix: "mer",
    users: [
      ["Mo Admin", "mo@meridian.example", "admin"],
      ["Remy Recruiter", "remy@meridian.example", "recruiter"],
      ["Quinn Analyst", "quinn@meridian.example", "analyst"],
    ],
    jobs: [
      ["Operations Manager", "Operations", "Chicago", "open"],
      ["Warehouse Lead", "Logistics", "Dallas", "open"],
      ["Backend Engineer", "Engineering", "Remote", "open"],
      ["Finance Analyst", "Finance", "Chicago", "closed"],
    ],
    candidateCount: 14,
  },
];

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2025, 0, 6); // Mon 6 Jan 2025

function buildFixtures() {
  const workspaceRows: NewWorkspace[] = [];
  const userRows: NewUser[] = [];
  const jobRows: NewJob[] = [];
  const candidateRows: NewCandidate[] = [];
  const applicationRows: NewApplication[] = [];

  for (const ws of WORKSPACES) {
    workspaceRows.push({ id: ws.id, slug: ws.slug, name: ws.name });

    ws.users.forEach(([name, email, role], i) => {
      userRows.push({
        id: `${ws.prefix}-user-${i + 1}`,
        workspaceId: ws.id,
        name,
        email,
        role,
      });
    });

    ws.jobs.forEach(([title, department, location, status], j) => {
      jobRows.push({
        id: `${ws.prefix}-job-${j + 1}`,
        workspaceId: ws.id,
        title,
        department,
        location,
        status,
        createdAt: new Date(BASE + j * 7 * DAY),
      });
    });

    const jobCount = ws.jobs.length;
    let appN = 0;

    for (let i = 0; i < ws.candidateCount; i++) {
      const first = FIRST[i % FIRST.length];
      const last = LAST[(i * 7) % LAST.length];
      const source = SOURCES[i % SOURCES.length];
      const candidateId = `${ws.prefix}-cand-${i + 1}`;

      candidateRows.push({
        id: candidateId,
        workspaceId: ws.id,
        name: `${first} ${last}`,
        email: `${first}.${last}.${i + 1}@example.com`.toLowerCase(),
        phone: `+1-555-${String(1000 + i).padStart(4, "0")}`,
        source,
        createdAt: new Date(BASE + i * 3 * DAY),
      });

      const appliedAt = new Date(BASE + i * 4 * DAY);
      applicationRows.push({
        id: `${ws.prefix}-app-${++appN}`,
        workspaceId: ws.id,
        candidateId,
        jobId: `${ws.prefix}-job-${(i % jobCount) + 1}`,
        stage: STAGES[i % STAGES.length],
        appliedAt,
        updatedAt: new Date(appliedAt.getTime() + (i % 15) * DAY),
      });

      // Every third candidate also applies to a second job.
      if (i % 3 === 0) {
        const appliedAt2 = new Date(BASE + (i * 4 + 2) * DAY);
        applicationRows.push({
          id: `${ws.prefix}-app-${++appN}`,
          workspaceId: ws.id,
          candidateId,
          jobId: `${ws.prefix}-job-${((i + 1) % jobCount) + 1}`,
          stage: STAGES[(i + 2) % STAGES.length],
          appliedAt: appliedAt2,
          updatedAt: new Date(appliedAt2.getTime() + ((i + 3) % 15) * DAY),
        });
      }
    }
  }

  return { workspaceRows, userRows, jobRows, candidateRows, applicationRows };
}

export async function seed(): Promise<void> {
  await runMigrations();

  // Wipe in FK-safe order, then re-insert. Keeps reseeds deterministic.
  await db.delete(applications);
  await db.delete(candidates);
  await db.delete(jobs);
  await db.delete(users);
  await db.delete(workspaces);

  const { workspaceRows, userRows, jobRows, candidateRows, applicationRows } =
    buildFixtures();

  await db.insert(workspaces).values(workspaceRows);
  await db.insert(users).values(userRows);
  await db.insert(jobs).values(jobRows);
  await db.insert(candidates).values(candidateRows);
  await db.insert(applications).values(applicationRows);

  for (const ws of WORKSPACES) {
    const c = candidateRows.filter((r) => r.workspaceId === ws.id).length;
    const a = applicationRows.filter((r) => r.workspaceId === ws.id).length;
    console.log(
      `Seeded ${ws.name} (${ws.slug}): ${ws.jobs.length} jobs, ${c} candidates, ${a} applications`,
    );
  }
  console.log("Seed complete.");
}

// Run only when invoked directly (tsx src/db/seed.ts), not when imported
// (e.g. by evals/run.ts, which calls `seed()` itself).
const invokedPath = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).pathname
  : "";
if (import.meta.url === `file://${invokedPath}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      // PGlite stores its data in a file-backed directory. If that directory
      // gets into a bad state (e.g. a dev process was killed mid-write), the
      // WASM engine can abort on open. Removing it and reseeding is safe.
      console.error(
        "\nIf this looks like a PGlite/WASM error, delete the data directory and reseed:\n  rm -rf ./.pglite && pnpm db:seed\n",
      );
      process.exit(1);
    });
}
