// Fixtures follow the response shapes observed on the live sites (Oct 2026).
import test from "node:test";
import assert from "node:assert/strict";
import { Http } from "../src/core/discover/http.ts";
import { appleHydration, makeSource, parseBloombergList } from "../src/core/discover/sources.ts";
import { discoverCompany } from "../src/core/discover/discover.ts";
import type { Company } from "../src/core/discover/companies.ts";

const noSleep = async () => {};
type Route = (url: string, init?: RequestInit) => unknown | Response;

/** Fake fetch: first route whose key appears in the URL answers. Objects become JSON, strings HTML. */
function fake(routes: Record<string, Route>, log: string[] = []): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const out = routes[key](url, init);
    if (out instanceof Response) return out;
    if (typeof out === "string") return new Response(out, { headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const http = (f: typeof fetch, maxRequests = 100) => new Http(f, { sleep: noSleep, maxRequests });

test("Http retries 429 with backoff, then succeeds", async () => {
  let calls = 0;
  const waits: number[] = [];
  const f = (async () => (++calls < 3 ? new Response("slow down", { status: 429 }) : new Response('{"ok":1}'))) as typeof fetch;
  const h = new Http(f, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await h.json("https://x"), { ok: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 8000]);
});

test("Http returns null once the request budget is spent", async () => {
  const h = http(fake({ x: () => ({}) }), 2);
  assert.ok(await h.json("https://x/1"));
  assert.ok(await h.json("https://x/2"));
  assert.equal(await h.json("https://x/3"), null);
  assert.equal(h.exhausted, true);
});

test("Http calls fetch without a `this` (Workers and browsers require it)", async () => {
  // Mimics the runtime check that throws "Illegal invocation".
  const strictFetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response('{"ok":true}'));
  } as unknown as typeof fetch;
  assert.deepEqual(await new Http(strictFetch, { sleep: noSleep }).json("https://x"), { ok: true });
});

test("Http sends a descriptive user agent", async () => {
  let ua = "";
  const f = (async (_: any, init?: RequestInit) => { ua = new Headers(init?.headers).get("user-agent") ?? ""; return new Response("{}"); }) as typeof fetch;
  await http(f).json("https://x");
  assert.match(ua, /JobTrackerAgent/);
});

test("Workday: pages with POST, builds public URLs, reads details", async () => {
  const bodies: any[] = [];
  const f = fake({
    "/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs": (_u, init) => {
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      if (b.searchText !== "software engineer") return { total: 0, jobPostings: [] };
      const page = b.offset / 20;
      const posts = page === 0
        ? Array.from({ length: 20 }, (_, i) => ({ title: `Software Engineer ${i}`, externalPath: `/job/US-CA/SE-${i}_JR${i}`, locationsText: "US, CA", bulletFields: [`JR${i}`] }))
        : [{ title: "C++ Software Engineer - New College Grad 2027", externalPath: "/job/US-CA/NCG_JR99", locationsText: "US, CA, Santa Clara", bulletFields: ["JR99"] }];
      return { total: 21, jobPostings: posts };
    },
    "/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA/NCG_JR99": () => ({ jobPostingInfo: { jobDescription: "<p>New grads welcome. 0-2 years of experience.</p>", externalUrl: "https://nvidia.wd5.myworkdayjobs.com/x" } }),
  });
  const src = makeSource({ kind: "workday", host: "nvidia.wd5.myworkdayjobs.com", tenant: "nvidia", site: "NVIDIAExternalCareerSite" });
  const h = http(f);
  const jobs = await src.list(h);
  assert.equal(jobs.length, 21);
  assert.deepEqual(bodies.slice(0, 2).map((b) => [b.searchText, b.offset, b.limit]), [["software engineer", 0, 20], ["software engineer", 20, 20]]);
  const ncg = jobs.find((j) => j.externalId === "JR99")!;
  assert.equal(ncg.url, "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA/NCG_JR99");
  assert.equal(ncg.description, undefined, "Workday lists have no description");
  assert.match((await src.detail!(ncg, h))!, /0-2 years of experience/);
});

test("Amazon: description and qualifications come with the list", async () => {
  const f = fake({
    "search.json": (url) => {
      const q = new URL(url).searchParams.get("base_query");
      if (q !== "software development engineer") return { hits: 0, jobs: [] };
      return {
        hits: 2,
        jobs: [
          { id_icims: "1", title: "Software Dev Engineer I", normalized_location: "Seattle, WA", job_path: "/en/jobs/1/sde-i", description: "Build services.", basic_qualifications: "- 1+ years of non-internship professional software development experience", preferred_qualifications: "- Masters" },
          { id_icims: "2", title: "Software Development Engineer", normalized_location: "Seattle, WA", job_path: "/en/jobs/2/sde", description: "Own systems.", basic_qualifications: "- 3+ years of non-internship professional software development experience<br/>- 3+ years of building production software" },
        ],
      };
    },
  });
  const jobs = await makeSource({ kind: "amazon" }).list(http(f));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, "https://www.amazon.jobs/en/jobs/1/sde-i");
  assert.match(jobs[1].description!, /3\+ years of non-internship/);
  assert.doesNotMatch(jobs[1].description!, /<br/);
});

test("Microsoft: search pages of 10, description from position_details", async () => {
  const f = fake({
    "/api/pcsx/search": (url) => {
      const u = new URL(url);
      if (u.searchParams.get("query") !== "software engineer") return { status: 200, data: { positions: [], count: 0 } };
      return { status: 200, data: { count: 2, positions: [
        { id: 111, name: "Software Engineer", standardizedLocations: ["Redmond, WA, US"], positionUrl: "/careers/job/111" },
        { id: 222, name: "Principal Software Engineer", standardizedLocations: ["Redmond, WA, US"] },
      ] } };
    },
    "position_details?position_id=111": () => ({ status: 200, data: { jobDescription: "<p>Required: 0-2 years of experience coding.</p>" } }),
  });
  const company: Company = { id: "microsoft", name: "Microsoft", group: "t", starred: false, source: { kind: "microsoft" } };
  const r = await discoverCompany(company, f, { sleep: noSleep });
  assert.equal(r.listed, 2);
  assert.deepEqual(r.matched.map((j) => [j.title, j.level, j.url]), [["Software Engineer", "entry", "https://apply.careers.microsoft.com/careers/job/111"]]);
  assert.equal(r.skipped.excluded, 1, "the principal role is excluded by title without a detail request");
});

test("Netflix: list paging and full description from the job endpoint", async () => {
  const log: string[] = [];
  const f = fake({
    "/api/apply/v2/jobs?": (url) => {
      const u = new URL(url);
      if (u.searchParams.get("query") !== "software engineer") return { count: 0, positions: [] };
      return { count: 2, positions: [
        { id: 7, name: "Software Engineer 4 - Revenue Infrastructure", location: "Remote, United States", canonicalPositionUrl: "https://explore.jobs.netflix.net/careers/job/7", job_description: "cut short" },
        { id: 8, name: "Staff Software Engineer 6", location: "Warsaw,Poland" },
      ] };
    },
    "/api/apply/v2/jobs/7?": () => ({ job_description: "<p>We value 1-3 years of experience.</p>" }),
  }, log);
  const company: Company = { id: "netflix", name: "Netflix", group: "t", starred: false, source: { kind: "netflix" } };
  const r = await discoverCompany(company, f, { sleep: noSleep });
  assert.deepEqual(r.matched.map((j) => [j.title, j.level]), [["Software Engineer 4 - Revenue Infrastructure", "maybe"]]);
  assert.ok(log.some((l) => l.includes("/api/apply/v2/jobs/7?")), "fetched the full description");
  assert.ok(!log.some((l) => l.includes("/api/apply/v2/jobs/8?")), "no detail request for an excluded title");
});

function appleHtml(data: unknown): string {
  return `<html><script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(data))});</script></html>`;
}

test("Apple: reads search results and details from embedded page data", async () => {
  const list = { loaderData: { root: {}, search: { totalRecords: 2, searchResults: [
    { id: "200-1", positionId: "200", postingTitle: "Software Engineer, New Grad", transformedPostingTitle: "software-engineer-new-grad", locations: [{ name: "Cupertino" }] },
    { id: "300-1", positionId: "300", postingTitle: "Graphics Software Engineer", transformedPostingTitle: "graphics-software-engineer", locations: [{ name: "Austin" }] },
  ] } } };
  const detail = (minQ: string) => ({ loaderData: { root: {}, jobDetails: { jobSummary: "Summary", description: "Desc", minimumQualifications: minQ, preferredQualifications: "Nice to have" } } });
  const f = fake({
    "/en-us/search?search=software%20engineer": (url) => (new URL(url).searchParams.get("page") === "1" ? appleHtml(list) : appleHtml({ loaderData: { search: { totalRecords: 2, searchResults: [] } } })),
    "/en-us/search?": () => appleHtml({ loaderData: { search: { totalRecords: 0, searchResults: [] } } }),
    "/en-us/details/200/": () => appleHtml(detail("BS in CS. Internship experience is a plus.")),
    "/en-us/details/300/": () => appleHtml(detail("BS + 10 years of relevant experience.")),
  });
  assert.ok(appleHydration(appleHtml({ a: "quote\" and \\ backslash" })));
  const company: Company = { id: "apple", name: "Apple", group: "t", starred: false, source: { kind: "apple" } };
  const r = await discoverCompany(company, f, { sleep: noSleep });
  assert.equal(r.listed, 2);
  assert.deepEqual(r.matched.map((j) => [j.title, j.level, j.url]), [["Software Engineer, New Grad", "entry", "https://jobs.apple.com/en-us/details/200/software-engineer-new-grad"]]);
  assert.equal(r.skipped.excluded, 1, "10 years required");
});

test("Apple: a changed page format is reported, not silently empty", async () => {
  const f = fake({ "/en-us/search": () => "<html>new design</html>" });
  await assert.rejects(makeSource({ kind: "apple" }).list(http(f)), /format changed/);
});

const BLOOMBERG_LIST = `
<div>80 results</div>
<article class="article article--result" id="article--1"> <div class="article__header"> <div class="article__header__text"> <h3 class="article__header__text__title title title--04"> <a class="link" href="https://bloomberg.avature.net/careers/JobDetail/Software-Engineer-2027/17073"> Software Engineer - 2027 </a> </h3> <div class="article__header__text__subtitle"> <span class="list-item-location">New York, New York, United States of America</span> </div> </div> </div> <div class="article__footer"> <a class="button button--primary" href="https://bloomberg.avature.net/careers/JobDetail/Software-Engineer-2027/17073">Apply</a></div> </article>
<article class="article article--result" id="article--2"> <h3><a class="link" href="https://bloomberg.avature.net/careers/JobDetail/Senior-Software-Engineer-Base-Layers/20448"> Senior Software Engineer &amp; Lead </a></h3> <span class="list-item-location">London</span> </article>`;

test("Bloomberg: parses the server-rendered list", () => {
  const { jobs, total } = parseBloombergList(BLOOMBERG_LIST);
  assert.equal(total, 80);
  assert.deepEqual(jobs.map((j) => [j.externalId, j.title, j.location]), [
    ["17073", "Software Engineer - 2027", "New York, New York, United States of America"],
    ["20448", "Senior Software Engineer & Lead", "London"],
  ]);
});

test("Bloomberg: description comes from the job page's main section", async () => {
  const f = fake({
    "SearchJobs/software%20engineer": () => BLOOMBERG_LIST.replace("80 results", "2 results"),
    "SearchJobs/": () => "<div>0 results</div>",
    "JobDetail/Software-Engineer-2027/17073": () => "<header>Menu 15 years of experience</header><main><p>Software Engineer</p><p>No prior experience required.</p></main>",
  });
  const company: Company = { id: "bloomberg", name: "Bloomberg", group: "t", starred: false, source: { kind: "bloomberg" } };
  const r = await discoverCompany(company, f, { sleep: noSleep });
  assert.deepEqual(r.matched.map((j) => [j.externalId, j.level]), [["17073", "entry"]]);
});

test("detail budget: title matches are flagged, plain titles kept as Maybe (JD not checked)", async () => {
  const positions = [
    { id: 1, name: "Software Engineer, New Grad" },
    { id: 2, name: "Software Engineer" },
    { id: 3, name: "Backend Engineer" },
  ];
  const f = fake({
    "/api/pcsx/search": (url) => (new URL(url).searchParams.get("query") === "software engineer" ? { data: { count: 3, positions } } : { data: { count: 0, positions: [] } }),
    "position_details": () => ({ data: { jobDescription: "Great team." } }),
  });
  const company: Company = { id: "microsoft", name: "Microsoft", group: "t", starred: false, source: { kind: "microsoft" } };
  const r = await discoverCompany(company, f, { sleep: noSleep, maxDetails: 0 });
  assert.deepEqual(r.matched.map((j) => [j.title, j.level, j.reasons.at(-1)]), [
    ["Software Engineer, New Grad", "entry", "description not checked"],
    ["Software Engineer", "maybe", "JD not checked"],
    ["Backend Engineer", "maybe", "JD not checked"],
  ]);
  assert.equal(r.notChecked, 2);
});

test("request budget stops listing early but keeps what was read", async () => {
  let n = 0;
  const f = fake({
    "/wday/cxs/": () => ({ total: 1000, jobPostings: Array.from({ length: 20 }, () => ({ title: "Software Engineer I", externalPath: `/job/${++n}`, bulletFields: [`R${n}`] })) }),
  });
  const company: Company = { id: "snap", name: "Snap", group: "t", starred: false, source: { kind: "workday", host: "h", tenant: "t", site: "s" } };
  const r = await discoverCompany(company, f, { sleep: noSleep, maxRequests: 3 });
  assert.equal(r.listed, 60);
  assert.equal(r.requests, 3);
  assert.equal(r.matched.length, 60, "entry titles kept even without descriptions");
});

// ---------- posting dates from each source ----------
import { listAshby, listGreenhouse, listLever } from "../src/core/discover/boards.ts";

test("board readers pick up posting dates", async () => {
  const fake = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const gh = await listGreenhouse("x", fake({ jobs: [{ id: 1, title: "SWE", first_published: "2026-10-16T12:00:00-04:00", updated_at: "2026-10-17T00:00:00Z" }, { id: 2, title: "SWE", updated_at: "2026-10-17T00:00:00Z" }] }));
  assert.equal(gh[0].postedAt, "2026-10-16T16:00:00.000Z");
  assert.equal(gh[1].postedAt, undefined, "updated_at alone isn't a posting date");
  const lv = await listLever("x", fake([{ id: "a", text: "SWE", createdAt: 1760000000000 }]));
  assert.equal(lv[0].postedAt, "2025-10-09T08:53:20.000Z");
  const ab = await listAshby("x", fake({ jobs: [{ id: "a", title: "SWE", publishedAt: "2026-10-15T00:00:00Z" }] }));
  assert.equal(ab[0].postedAt, "2026-10-15T00:00:00.000Z");
});

test("429 retries honor Retry-After and per-source backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  const f = (async () => {
    calls++;
    return calls < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "20" } }) : new Response("{}");
  }) as unknown as typeof fetch;
  const http = new Http(f, { backoffMs: [5000, 15000], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await http.json("https://x"), {});
  assert.deepEqual(waits, [20000, 20000], "Retry-After (20 s) beats the shorter 5 s and 15 s backoffs");
});

test("salary is read from the full description, and Ashby's compensation field counts", async () => {
  const longJd = "Build things. 0-2 years of experience. " + "x".repeat(5000) + " The base salary range is $138,000 - $192,000 USD.";
  const gh = fake({ "boards/acme/jobs": () => ({ jobs: [{ id: 1, title: "Software Engineer", location: { name: "NYC" }, absolute_url: "u", content: longJd }] }) });
  const c1: Company = { id: "acme", name: "Acme", group: "t", starred: false, source: { kind: "greenhouse", slug: "acme" } };
  const r1 = await discoverCompany(c1, gh, { sleep: noSleep, keepDescription: true });
  assert.deepEqual(r1.matched[0].salary, { min: 138000, max: 192000 }, "found past the 4,000-character cut");

  const ab = fake({ "job-board/acme": () => ({ jobs: [{ id: "a", title: "Software Engineer, New Grad", location: "NYC", jobUrl: "u", descriptionPlain: "Join us.", compensation: { compensationTierSummary: "$120K – $150K • Offers Equity" } }] }) });
  const c2: Company = { id: "acme", name: "Acme", group: "t", starred: false, source: { kind: "ashby", slug: "acme" } };
  const r2 = await discoverCompany(c2, ab, { sleep: noSleep });
  assert.deepEqual(r2.matched[0].salary, { min: 120000, max: 150000 });
});
