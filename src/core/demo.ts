// Sample data for the public demo. Everything here is fictional and labeled as
// a sample in the page; the found jobs come from a real scan (the catalog).
import type { DiscoveredJob } from "./discover/discover.ts";
import type { Application, CatalogSnapshot, TrackerState } from "./types.ts";
import { emptyState } from "./types.ts";

export const SAMPLE_RESUME_NAME = "Sample resume (fictional): Alex Rivera";

export const SAMPLE_RESUME = `Alex Rivera (fictional sample resume)
Software Engineer in Test | Austin, TX

SUMMARY
Software engineer in test with 2 years of experience building test automation and CI tooling for a B2B web platform. Moving into product engineering. Comfortable across Python, TypeScript and Go.

EXPERIENCE
Software Engineer in Test, Fieldline Analytics (fictional), 2024 to present
- Built a Playwright + TypeScript end-to-end suite (600+ tests) that runs on every pull request; cut release regressions by about 40%.
- Wrote a Python service that shards tests across CI workers, reducing pipeline time from 38 to 11 minutes.
- Added contract tests for 12 internal REST APIs and caught breaking changes before deploy.
- Built a flaky-test dashboard (React, PostgreSQL) used by 5 teams.

Software Engineering Intern, Northbank Systems (fictional), Summer 2023
- Added pagination and caching to a Go microservice; p95 latency dropped from 420 ms to 130 ms.

PROJECTS
Job Tracker Agent: AI agent on Cloudflare Workers (Agents SDK, Workflows, Workers AI) that screens job postings and drafts cover letters.

SKILLS
Python, TypeScript, Go, SQL; React, Node.js; Playwright, pytest; Docker, GitHub Actions, AWS; PostgreSQL, Redis

EDUCATION
B.S. Computer Science, University of Texas at Austin (2024)`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A pre-filled application that has been "applied" long enough to need a follow-up. */
function sampleApplication(job: DiscoveredJob | undefined, now: number): Application {
  const appliedAt = new Date(now - 18 * DAY_MS).toISOString();
  const company = job?.companyName ?? "Example Corp";
  const title = job?.title ?? "Software Engineer, New Grad";
  return {
    id: "sample-application",
    url: job?.url ?? "https://example.com/careers/software-engineer-new-grad",
    company,
    title,
    status: "applied",
    fitScore: 74,
    strengths: ["Test automation at scale (Playwright, CI)", "Python and TypeScript services", "Measurable impact on release quality"],
    gaps: ["Limited production feature work", "No distributed systems experience on the resume"],
    coverLetter:
      `(Sample letter) Hi ${company} team,\n\n` +
      `I'm applying for the ${title} role. For the past two years I've built test automation and CI tooling: ` +
      "a Playwright suite of 600+ tests that cut release regressions by about 40%, and a Python test-sharding service " +
      "that brought our pipeline from 38 to 11 minutes. I'd like to bring that focus on reliability and measurable " +
      "results to product engineering.\n\nThank you for your time,\nAlex Rivera",
    createdAt: appliedAt,
    updatedAt: appliedAt,
    sample: true,
  };
}

/** A visitor's starting state: sample resume, the shared job snapshot, one sample application. */
export function demoState(snapshot: CatalogSnapshot, now = Date.now()): TrackerState {
  const firstEntry = snapshot.discovered.find((j) => j.level === "entry") ?? snapshot.discovered[0];
  return {
    ...emptyState(),
    resumeName: SAMPLE_RESUME_NAME,
    resume: SAMPLE_RESUME,
    discovered: snapshot.discovered,
    lastDiscovery: snapshot.lastDiscovery,
    applications: [sampleApplication(firstEntry, now)],
    demoSeededAt: new Date(now).toISOString(),
  };
}

const LEVELS = new Set(["entry", "maybe"]);

/** Keeps only well-formed jobs from an uploaded snapshot (it comes over the network). */
export function sanitizeCatalog(input: unknown): CatalogSnapshot {
  const body = (input ?? {}) as { jobs?: unknown; lastDiscovery?: unknown };
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const discovered: DiscoveredJob[] = [];
  for (const raw of jobs.slice(0, 2000)) {
    const j = (raw ?? {}) as Record<string, unknown>;
    const id = str(j.id, 200);
    const url = str(j.url, 1000);
    if (!id || !str(j.title) || !/^https?:\/\//.test(url) || !LEVELS.has(String(j.level))) continue;
    discovered.push({
      id,
      externalId: str(j.externalId, 200),
      company: str(j.company, 60),
      companyName: str(j.companyName, 120),
      title: str(j.title),
      location: str(j.location),
      url,
      detailRef: j.detailRef === undefined ? undefined : str(j.detailRef, 1000),
      category: str(j.category, 30) as DiscoveredJob["category"],
      level: j.level as DiscoveredJob["level"],
      reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 6).map((r) => str(r, 120)) : [],
      firstSeen: str(j.firstSeen, 40) || new Date().toISOString(),
    });
  }
  const lastDiscovery: Record<string, string> = {};
  if (body.lastDiscovery && typeof body.lastDiscovery === "object") {
    for (const [k, v] of Object.entries(body.lastDiscovery as Record<string, unknown>).slice(0, 100)) {
      if (typeof v === "string") lastDiscovery[k.slice(0, 60)] = v.slice(0, 40);
    }
  }
  return { discovered, lastDiscovery };
}
