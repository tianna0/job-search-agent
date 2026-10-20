import { classify, type Category, type Classification } from "./classify.ts";
import { Http } from "./http.ts";
import { makeSource, type ListedJob } from "./sources.ts";
import type { Company } from "./companies.ts";
import { parseSalary, type Salary } from "./salary.ts";

export interface DiscoveredJob {
  id: string; // `${company}:${externalId}`
  externalId: string;
  company: string; // company id
  companyName: string;
  title: string;
  location: string;
  url: string;
  detailRef?: string;
  category: Category;
  level: "entry" | "maybe";
  reasons: string[];
  firstSeen: string;
  /** Job description text, only kept when asked (job alerts use it for ranking). */
  description?: string;
  /** When the company posted it (ISO), if the site says. */
  postedAt?: string;
  /** Annual USD pay range stated in the description, if any. */
  salary?: Salary;
}

export interface DiscoverResult {
  listed: number;
  matched: DiscoveredJob[];
  skipped: { notSwe: number; excluded: number; noSignal: number };
  /** Jobs whose description we couldn't read because the request limit was hit. */
  notChecked: number;
  requests: number;
}

export interface DiscoverOptions {
  /** Request limit for one company. Cloudflare Workers allow ~50 per request. */
  maxRequests?: number;
  /** Most job descriptions to fetch for one company. */
  maxDetails?: number;
  now?: string;
  /** Keep each match's description text (up to 4,000 characters). */
  keepDescription?: boolean;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

function sourceOf(company: Company) {
  if (!company.source) throw new Error(company.note ?? "This company can't be read automatically.");
  return makeSource(company.source);
}

/** Read one company's jobs and keep only those that pass the screening rules. */
export async function discoverCompany(
  company: Company,
  doFetch: typeof fetch,
  opts: DiscoverOptions = {}
): Promise<DiscoverResult> {
  const source = sourceOf(company);
  const http = new Http(doFetch, {
    delayMs: source.delayMs,
    backoffMs: source.backoffMs,
    maxRequests: opts.maxRequests ?? 150,
    sleep: opts.sleep,
  });
  const now = opts.now ?? new Date().toISOString();
  const maxDetails = opts.maxDetails ?? 60;

  const listed = await source.list(http);
  const skipped = { notSwe: 0, excluded: 0, noSignal: 0 };
  const matched: DiscoveredJob[] = [];

  const keep = (j: ListedJob, c: Classification, extra?: string, text?: string) => {
    matched.push({
      id: `${company.id}:${j.externalId}`,
      externalId: j.externalId,
      company: company.id,
      companyName: company.name,
      title: j.title,
      location: j.location,
      url: j.url,
      detailRef: j.detailRef,
      category: c.category!,
      level: c.level as "entry" | "maybe",
      reasons: extra ? [...c.reasons, extra] : c.reasons,
      firstSeen: now,
      ...(j.postedAt ? { postedAt: j.postedAt } : {}),
      ...(() => {
        // Read the pay range from the full text, before it's cut to 4,000 characters.
        const salary = text ? parseSalary(text) : undefined;
        return salary ? { salary } : {};
      })(),
      ...(opts.keepDescription && text ? { description: text.slice(0, 4000) } : {}),
    });
  };
  const tally = (c: Classification) => {
    if (!c.category) skipped.notSwe++;
    else if (c.level === "excluded") skipped.excluded++;
    else skipped.noSignal++;
  };

  // Jobs that still need their description, after a title-only screen.
  const needDetail: { job: ListedJob; byTitle: Classification }[] = [];

  for (const j of listed) {
    if (j.description !== undefined) {
      const c = classify(j.title, j.description);
      if (c.category && (c.level === "entry" || c.level === "maybe")) keep(j, c, undefined, j.description);
      else tally(c);
      continue;
    }
    const byTitle = classify(j.title);
    if (!byTitle.category || byTitle.level === "excluded") {
      tally(byTitle);
      continue;
    }
    needDetail.push({ job: j, byTitle });
  }

  // Titles that already look entry/maybe go first; plain titles after.
  needDetail.sort((a, b) => Number(b.byTitle.level !== "unknown") - Number(a.byTitle.level !== "unknown"));

  let fetched = 0;
  let notChecked = 0;
  for (const { job, byTitle } of needDetail) {
    let desc: string | null = null;
    if (fetched < maxDetails && !http.exhausted && source.detail) {
      try {
        desc = await source.detail(job, http);
      } catch {
        desc = null; // one bad posting shouldn't stop the run
      }
      if (desc !== null) fetched++;
    }
    if (desc === null) {
      // Couldn't read the description: keep title-level matches, flagged; a plain
      // software title is still worth a look, as a Maybe.
      if (byTitle.level === "entry" || byTitle.level === "maybe") keep(job, byTitle, "description not checked");
      else {
        notChecked++;
        keep(job, { ...byTitle, level: "maybe", reasons: ["JD not checked"] });
      }
      continue;
    }
    const c = classify(job.title, desc);
    if (c.category && (c.level === "entry" || c.level === "maybe")) keep(job, c, undefined, desc);
    else tally(c);
  }

  return { listed: listed.length, matched, skipped, notChecked, requests: http.used };
}

/** Get the full text of one discovered job, for analysis. */
export async function fetchDiscoveredJob(
  company: Company,
  job: { externalId: string; url: string; detailRef?: string },
  doFetch: typeof fetch
): Promise<{ title?: string; location?: string; description: string } | undefined> {
  const source = sourceOf(company);
  const http = new Http(doFetch, { maxRequests: 10 });
  if (source.detail) {
    const d = await source.detail(job, http);
    return d ? { description: d } : undefined;
  }
  const found = (await source.list(http)).find((j) => j.externalId === job.externalId);
  return found && found.description !== undefined
    ? { title: found.title, location: found.location, description: found.description }
    : undefined;
}

/** Replace one company's results, keeping the first-seen time of jobs we already knew. */
export function mergeDiscovered(
  existing: DiscoveredJob[],
  company: string,
  fresh: DiscoveredJob[]
): { jobs: DiscoveredJob[]; newIds: string[] } {
  const before = new Map(existing.filter((j) => j.company === company).map((j) => [j.id, j]));
  const newIds: string[] = [];
  const merged = fresh.map((j) => {
    const old = before.get(j.id);
    if (old) return { ...j, firstSeen: old.firstSeen };
    newIds.push(j.id);
    return j;
  });
  return { jobs: [...existing.filter((j) => j.company !== company), ...merged], newIds };
}
