// Every place we can read jobs from, behind one interface:
//   list()   -> jobs found by searching (description may be missing)
//   detail() -> full description of one job (when the list doesn't include it)
//
// Each reader below was checked against the live site in October 2026
// (response shape, paging, and robots.txt). Sites change; if one breaks,
// `npm run check-companies` will show it.
import { htmlToText } from "../jobpage.ts";
import { listAshby, listGreenhouse, listLever } from "./boards.ts";
import type { Http } from "./http.ts";
import { firstDate, workdayPosted } from "./posted.ts";

export interface ListedJob {
  externalId: string;
  title: string;
  location: string;
  url: string;
  /** Plain-text description, if the list already includes it. */
  description?: string;
  /** Whatever detail() needs to find this job again. */
  detailRef?: string;
  /** When the job was posted (ISO), if the site says. */
  postedAt?: string;
}

export type SourceConfig =
  | { kind: "greenhouse"; slug: string }
  | { kind: "lever"; slug: string }
  | { kind: "ashby"; slug: string }
  | { kind: "workday"; host: string; tenant: string; site: string }
  | { kind: "amazon" }
  | { kind: "microsoft" }
  | { kind: "netflix" }
  | { kind: "apple" }
  | { kind: "bloomberg" };

export interface Source {
  /** Pause between requests for this site, in ms. */
  delayMs: number;
  /** Waits before retrying a rate-limited (429) request; defaults to Http's. */
  backoffMs?: number[];
  list(http: Http): Promise<ListedJob[]>;
  detail?(job: { externalId: string; url: string; detailRef?: string }, http: Http): Promise<string | null>;
}

// Search terms for sites that need a query. The title rules do the real filtering.
const QUERIES = ["software engineer", "new grad", "SDET"];

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Adapts Http to the fetch signature the Greenhouse/Lever/Ashby readers expect. */
function asFetch(http: Http): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const res = await http.request(String(input), init);
    if (!res) throw new Error("request limit reached");
    return res;
  }) as typeof fetch;
}

function dedupe(jobs: ListedJob[]): ListedJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => (seen.has(j.externalId) ? false : (seen.add(j.externalId), true)));
}

// ---------- Workday (Nvidia, Adobe, Salesforce, Snap) ----------

function workday(c: { host: string; tenant: string; site: string }): Source {
  const api = `https://${c.host}/wday/cxs/${c.tenant}/${c.site}`;
  const PAGE = 20; // Workday's maximum
  const MAX_PAGES = 8;
  return {
    delayMs: 300,
    async list(http) {
      const out: ListedJob[] = [];
      for (const q of QUERIES) {
        for (let page = 0; page < MAX_PAGES; page++) {
          const data = await http.json(`${api}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: q }),
          });
          if (!data) return dedupe(out);
          const posts: any[] = data.jobPostings ?? [];
          for (const p of posts) {
            if (!p.externalPath) continue;
            out.push({
              externalId: String(p.bulletFields?.[0] ?? p.externalPath),
              title: String(p.title ?? ""),
              location: String(p.locationsText ?? ""),
              url: `https://${c.host}/${c.site}${p.externalPath}`,
              detailRef: String(p.externalPath),
              postedAt: workdayPosted(p.postedOn),
            });
          }
          if (posts.length < PAGE || (page + 1) * PAGE >= Number(data.total ?? 0)) break;
        }
      }
      return dedupe(out);
    },
    async detail(job, http) {
      const data = await http.json(`${api}${job.detailRef}`);
      if (!data) return null;
      const info = data.jobPostingInfo ?? {};
      return htmlToText(String(info.jobDescription ?? ""));
    },
  };
}

// ---------- Amazon ----------

const amazon: Source = {
  delayMs: 500,
  async list(http) {
    const out: ListedJob[] = [];
    const PAGE = 100;
    const MAX_PAGES = 5;
    for (const q of ["software development engineer", "software engineer", "SDET"]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}` +
          `&result_limit=${PAGE}&offset=${page * PAGE}&sort=recent`;
        const data = await http.json(url);
        if (!data) return dedupe(out);
        const jobs: any[] = data.jobs ?? [];
        for (const j of jobs) {
          const text = [j.description, "Basic qualifications:", j.basic_qualifications, "Preferred qualifications:", j.preferred_qualifications]
            .filter(Boolean)
            .join("\n");
          out.push({
            externalId: String(j.id_icims ?? j.id),
            title: String(j.title ?? ""),
            location: String(j.normalized_location ?? j.location ?? ""),
            url: `https://www.amazon.jobs${j.job_path ?? ""}`,
            description: htmlToText(text),
            postedAt: firstDate(j.posted_date),
          });
        }
        if (jobs.length < PAGE || (page + 1) * PAGE >= Number(data.hits ?? 0)) break;
      }
    }
    return dedupe(out);
  },
  async detail(job, http) {
    const html = await http.text(job.url, { headers: { accept: "text/html" } });
    return html === null ? null : htmlToText(html);
  },
};

// ---------- Microsoft (Eightfold "pcsx" API; rate-limited, so slow) ----------

const microsoft: Source = {
  delayMs: 2500,
  backoffMs: [5000, 15000, 30000, 60000],
  async list(http) {
    const out: ListedJob[] = [];
    const PAGE = 10; // fixed by the site
    const MAX_PAGES = 6;
    for (const q of QUERIES) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com` +
          `&query=${encodeURIComponent(q)}&location=&start=${page * PAGE}`;
        let res: any;
        try {
          res = await http.json(url);
        } catch (err) {
          // Still rate-limited after every retry: keep what we already have.
          if (out.length) return dedupe(out);
          throw err;
        }
        if (!res) return dedupe(out);
        const data = res.data ?? {};
        const positions: any[] = data.positions ?? [];
        for (const p of positions) {
          out.push({
            externalId: String(p.id),
            title: String(p.name ?? ""),
            location: (p.standardizedLocations ?? p.locations ?? []).join("; "),
            url: `https://apply.careers.microsoft.com/careers/job/${p.id}`,
            detailRef: String(p.id),
            postedAt: firstDate(p.postedTs, p.creationTs, p.t_create),
          });
        }
        if (positions.length < PAGE || (page + 1) * PAGE >= Number(data.count ?? 0)) break;
      }
    }
    return dedupe(out);
  },
  async detail(job, http) {
    const res = await http.json(
      `https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=${job.detailRef ?? job.externalId}&domain=microsoft.com&hl=en`
    );
    if (!res) return null;
    return htmlToText(String(res.data?.jobDescription ?? ""));
  },
};

// ---------- Netflix (Eightfold "apply v2" API) ----------

const netflix: Source = {
  delayMs: 800,
  async list(http) {
    const out: ListedJob[] = [];
    const PAGE = 10; // the API ignores larger values
    const MAX_PAGES = 20;
    for (const q of ["software engineer", "SDET"]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com` +
          `&query=${encodeURIComponent(q)}&start=${page * PAGE}&num=${PAGE}`;
        const data = await http.json(url);
        if (!data) return dedupe(out);
        const positions: any[] = data.positions ?? [];
        for (const p of positions) {
          out.push({
            externalId: String(p.id),
            title: String(p.name ?? ""),
            location: String(p.location ?? ""),
            url: String(p.canonicalPositionUrl ?? `https://explore.jobs.netflix.net/careers/job/${p.id}`),
            detailRef: String(p.id), // list descriptions are cut short; fetch the full one
            postedAt: firstDate(p.t_create, p.postedTs, p.creationTs),
          });
        }
        if (positions.length < PAGE || (page + 1) * PAGE >= Number(data.count ?? 0)) break;
      }
    }
    return dedupe(out);
  },
  async detail(job, http) {
    const data = await http.json(
      `https://explore.jobs.netflix.net/api/apply/v2/jobs/${job.detailRef ?? job.externalId}?domain=netflix.com`
    );
    if (!data) return null;
    return htmlToText(String(data.job_description ?? ""));
  },
};

// ---------- Apple (data embedded in the server-rendered page) ----------

/** Apple pages embed their data as window.__staticRouterHydrationData = JSON.parse("..."). */
export function appleHydration(html: string): any | null {
  const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) return null;
  try {
    return JSON.parse(JSON.parse(m[1]));
  } catch {
    return null;
  }
}

function findDeep(o: any, test: (x: any) => boolean, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 7) return null;
  if (test(o)) return o;
  for (const v of Object.values(o)) {
    const f = findDeep(v, test, depth + 1);
    if (f) return f;
  }
  return null;
}

const apple: Source = {
  delayMs: 600,
  async list(http) {
    const out: ListedJob[] = [];
    const MAX_PAGES = 8; // 20 per page, newest first
    for (const q of QUERIES) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const html = await http.text(
          `https://jobs.apple.com/en-us/search?search=${encodeURIComponent(q)}&sort=newest&page=${page}`,
          { headers: { accept: "text/html" } }
        );
        if (html === null) return dedupe(out);
        const data = appleHydration(html);
        const search = findDeep(data?.loaderData, (x) => Array.isArray(x.searchResults));
        if (!search) {
          if (page === 1) throw new Error("Apple page format changed (no search data found)");
          break;
        }
        const results: any[] = search.searchResults;
        for (const r of results) {
          const slug = String(r.transformedPostingTitle ?? "job");
          out.push({
            externalId: String(r.positionId ?? r.id),
            title: String(r.postingTitle ?? ""),
            location: (r.locations ?? []).map((l: any) => l.name).filter(Boolean).join("; "),
            url: `https://jobs.apple.com/en-us/details/${r.positionId}/${slug}`,
            detailRef: `/en-us/details/${r.positionId}/${slug}`,
            postedAt: firstDate(r.postDateInGMT, r.postingDate),
          });
        }
        if (results.length < 20 || page * 20 >= Number(search.totalRecords ?? 0)) break;
      }
    }
    return dedupe(out);
  },
  async detail(job, http) {
    const html = await http.text(`https://jobs.apple.com${job.detailRef}`, { headers: { accept: "text/html" } });
    if (html === null) return null;
    const data = appleHydration(html);
    const d = findDeep(data?.loaderData, (x) => "minimumQualifications" in x || "jobSummary" in x);
    if (!d) return htmlToText(html);
    return [
      d.jobSummary,
      d.description,
      d.minimumQualifications && `Minimum qualifications:\n${d.minimumQualifications}`,
      d.preferredQualifications && `Preferred qualifications:\n${d.preferredQualifications}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  },
};

// ---------- Bloomberg (Avature, server-rendered HTML) ----------

export function parseBloombergList(html: string): { jobs: ListedJob[]; total: number } {
  const jobs: ListedJob[] = [];
  const articles = html.match(/<article class="article article--result"[\s\S]*?<\/article>/g) ?? [];
  for (const a of articles) {
    const link = a.match(/<a[^>]*href="([^"]*\/JobDetail\/[^"]*?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const loc = a.match(/<span class="list-item-location">([\s\S]*?)<\/span>/);
    jobs.push({
      externalId: link[2],
      title: decodeEntities(link[3].replace(/<[^>]+>/g, "").trim()),
      location: loc ? decodeEntities(loc[1].trim()) : "",
      url: decodeEntities(link[1]),
    });
  }
  const total = Number((html.match(/(\d[\d,]*)\s+results/i)?.[1] ?? "0").replace(/,/g, ""));
  return { jobs, total };
}

const bloomberg: Source = {
  delayMs: 600,
  async list(http) {
    const out: ListedJob[] = [];
    const PAGE = 12;
    const MAX_PAGES = 8;
    for (const q of ["software engineer", "SDET"]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const html = await http.text(
          `https://bloomberg.avature.net/careers/SearchJobs/${encodeURIComponent(q)}/?jobRecordsPerPage=${PAGE}&jobOffset=${page * PAGE}`,
          { headers: { accept: "text/html" } }
        );
        if (html === null) return dedupe(out);
        const { jobs, total } = parseBloombergList(html);
        out.push(...jobs);
        if (jobs.length < PAGE || (page + 1) * PAGE >= total) break;
      }
    }
    return dedupe(out);
  },
  async detail(job, http) {
    const html = await http.text(job.url, { headers: { accept: "text/html" } });
    if (html === null) return null;
    const main = html.match(/<main[\s\S]*?<\/main>/i);
    return htmlToText(main ? main[0] : html);
  },
};

// ---------- Greenhouse / Lever / Ashby (whole board in one request) ----------

function board(kind: "greenhouse" | "lever" | "ashby", slug: string): Source {
  const reader = kind === "greenhouse" ? listGreenhouse : kind === "lever" ? listLever : listAshby;
  return {
    delayMs: 0,
    async list(http) {
      return reader(slug, asFetch(http));
    },
  };
}

export function makeSource(c: SourceConfig): Source {
  switch (c.kind) {
    case "greenhouse":
    case "lever":
    case "ashby":
      return board(c.kind, c.slug);
    case "workday":
      return workday(c);
    case "amazon":
      return amazon;
    case "microsoft":
      return microsoft;
    case "netflix":
      return netflix;
    case "apple":
      return apple;
    case "bloomberg":
      return bloomberg;
  }
}
