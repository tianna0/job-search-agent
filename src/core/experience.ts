// A closer read of how much experience a job requires, for the jobs about to be
// emailed. The screening rules (classify.ts) only drop clear misses; this asks a
// model to read the experience lines of each JD, because postings word required
// vs. preferred experience in too many ways for rules alone.
//
// Cost: one short call per job (an excerpt of a few lines, a reply of a few
// tokens), only for jobs that passed every other filter. That's a few dozen
// calls a day, well inside the Workers AI free allowance.
// If the model can't be reached, the rule-based count is used instead.
import type { DiscoveredJob } from "./discover/discover.ts";
import { MAX_YEARS } from "./discover/classify.ts";
import type { LLM } from "./types.ts";

export const YEARS_SYSTEM =
  "You read excerpts of job postings. Each line mentions years of experience and is shown under its section heading. " +
  "Find the minimum years of professional experience the job REQUIRES. Ignore anything preferred, desired, a plus, or nice to have. " +
  "If the posting offers alternatives (e.g. BS + 5 years or MS + 3 years), use the smallest. " +
  "Internships and education are not professional experience. " +
  'Reply with ONLY a JSON object: {"years": number} or {"years": null} if no requirement is stated.';

/** {"years": 3} -> 3, {"years": null} -> null, anything unreadable -> undefined. */
export function parseYears(reply: string): number | null | undefined {
  const m = reply.match(/\{[^{}]*\}/);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[0]).years;
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 40 ? n : undefined;
  } catch {
    return undefined;
  }
}

export interface ExperienceReview {
  kept: DiscoveredJob[];
  dropped: DiscoveredJob[];
  /** Jobs the model read. */
  checked: number;
  /** Set when the model couldn't be used; the rule-based count was used instead. */
  error?: string;
}

/**
 * Keeps jobs that require at most maxYears of experience.
 * Jobs whose JD never mentions years are kept without a call.
 */
export async function reviewExperience(
  jobs: DiscoveredJob[],
  llm: LLM | null,
  opts: { maxYears?: number; maxCalls?: number } = {}
): Promise<ExperienceReview> {
  const maxYears = opts.maxYears ?? MAX_YEARS;
  const maxCalls = opts.maxCalls ?? 150;
  const kept: DiscoveredJob[] = [];
  const dropped: DiscoveredJob[] = [];
  let checked = 0;
  let error: string | undefined = llm ? undefined : "no model available";

  const byRule = (j: DiscoveredJob) => (j.requiredYears !== undefined && j.requiredYears > maxYears ? dropped : kept).push(j);

  for (const j of jobs) {
    if (!j.experience) {
      byRule(j);
      continue;
    }
    if (error || !llm || checked >= maxCalls) {
      byRule(j);
      continue;
    }
    let years: number | null | undefined;
    try {
      checked++;
      years = parseYears(await llm.complete(YEARS_SYSTEM, `JOB: ${j.title} at ${j.companyName}\n${j.experience}`));
    } catch (err) {
      // Usually missing credentials or the daily allowance: stop calling for this run.
      error = (err as Error).message;
      byRule(j);
      continue;
    }
    if (years === undefined) {
      byRule(j);
    } else if (years === null) {
      kept.push(j);
    } else if (years > maxYears) {
      dropped.push({ ...j, reasons: [...j.reasons, `AI: ${years}+ years required`] });
    } else {
      kept.push({ ...j, reasons: [...j.reasons, `AI: ${years} years required`] });
    }
  }
  return { kept, dropped, checked, ...(error ? { error } : {}) };
}
