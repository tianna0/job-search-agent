import test from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "../src/core/tracker.ts";
import { COMPANIES } from "../src/core/discover/companies.ts";
import { discoverCompany, mergeDiscovered } from "../src/core/discover/discover.ts";
import { listAshby, listGreenhouse, listLever } from "../src/core/discover/boards.ts";
import { emptyState, type TrackerState } from "../src/core/types.ts";

const BASE = "http://test/agents/job-tracker/default";
const body = (s: string) => `<p>${s}</p>`;

const GREENHOUSE = {
  jobs: [
    { id: 1, title: "Software Engineer, New Grad", location: { name: "NYC" }, absolute_url: "https://x/1", content: "&lt;p&gt;Build things in Python. 0-2 years of experience.&lt;/p&gt;" },
    { id: 2, title: "Senior Software Engineer", location: { name: "SF" }, absolute_url: "https://x/2", content: "&lt;p&gt;5 years experience&lt;/p&gt;" },
    { id: 3, title: "Software Engineer II", location: { name: "SF" }, absolute_url: "https://x/3", content: "&lt;p&gt;Great team&lt;/p&gt;" },
    { id: 4, title: "Product Designer", location: { name: "SF" }, absolute_url: "https://x/4", content: "" },
    { id: 5, title: "Software Engineer", location: { name: "SF" }, absolute_url: "https://x/5", content: "&lt;p&gt;Join us&lt;/p&gt;" },
    { id: 6, title: "Backend Engineer, New Grad", location: { name: "DC" }, absolute_url: "https://x/6", content: "&lt;p&gt;Active TS/SCI clearance required&lt;/p&gt;" },
  ],
};

const LEVER = [
  { id: "a1", text: "Software Engineer I", categories: { location: "London" }, hostedUrl: "https://l/a1", descriptionPlain: "Entry role", lists: [{ text: "Requirements", content: "<li>1 year of experience</li>" }] },
  { id: "a2", text: "Staff Engineer", categories: { location: "London" }, hostedUrl: "https://l/a2", descriptionPlain: "" },
];

const ASHBY = {
  jobs: [
    { id: "b1", title: "Frontend Engineer, Early Career", location: "Remote", jobUrl: "https://a/b1", descriptionPlain: "React", isListed: true },
    { id: "b2", title: "Backend Engineer, New Grad", location: "Remote", jobUrl: "https://a/b2", descriptionPlain: "Go", isListed: false },
  ],
};

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const hit = Object.keys(map).find((k) => url.includes(k));
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(map[hit]), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("every company has a unique id and a platform or none", () => {
  const ids = new Set(COMPANIES.map((c) => c.id));
  assert.equal(ids.size, COMPANIES.length);
  assert.equal(COMPANIES.length, 40);
  for (const c of COMPANIES) {
    if (c.source === null) assert.ok(c.note, `${c.id} needs a reason it can't be read`);
  }
  const manual = COMPANIES.filter((c) => !c.source).map((c) => c.id).sort();
  assert.deepEqual(manual, ["google", "linkedin", "meta", "uber"]);
});

test("Greenhouse, Lever and Ashby readers normalize jobs", async () => {
  const gh = await listGreenhouse("acme", fakeFetch({ "boards/acme/jobs": GREENHOUSE }));
  assert.equal(gh.length, 6);
  assert.match(gh[0].description, /Build things in Python/);
  assert.doesNotMatch(gh[0].description, /&lt;|<p>/);

  const lv = await listLever("acme", fakeFetch({ "postings/acme": LEVER }));
  assert.equal(lv[0].title, "Software Engineer I");
  assert.match(lv[0].description, /1 year of experience/);

  const ab = await listAshby("acme", fakeFetch({ "job-board/acme": ASHBY }));
  assert.equal(ab.length, 1, "unlisted Ashby jobs are dropped");
});

test("discoverCompany keeps only matching jobs and counts the rest", async () => {
  const company = { id: "acme", name: "Acme", group: "t", starred: false, source: { kind: "greenhouse" as const, slug: "acme" } };
  const r = await discoverCompany(company, fakeFetch({ "boards/acme/jobs": GREENHOUSE }), { now: "2026-01-01T00:00:00Z" });
  assert.equal(r.listed, 6);
  assert.deepEqual(r.matched.map((j) => [j.externalId, j.level]), [["1", "entry"], ["3", "maybe"]]);
  assert.deepEqual(r.skipped, { notSwe: 1, excluded: 2, noSignal: 1 });
  assert.equal(r.matched[0].category, "SWE");
  assert.equal(r.matched[0].companyName, "Acme");
});

test("mergeDiscovered flags new jobs and keeps first-seen time", () => {
  const job = (id: string, firstSeen: string) => ({ id: `c:${id}`, externalId: id, company: "c", companyName: "C", title: "t", location: "", url: "", category: "SWE" as const, level: "entry" as const, reasons: [], firstSeen });
  const existing = [job("1", "old"), { ...job("9", "x"), company: "other", id: "other:9" }];
  const { jobs, newIds } = mergeDiscovered(existing, "c", [job("1", "new"), job("2", "new")]);
  assert.deepEqual(newIds, ["c:2"]);
  assert.equal(jobs.find((j) => j.id === "c:1")!.firstSeen, "old");
  assert.ok(jobs.some((j) => j.id === "other:9"), "other companies are untouched");
});

function setup(map: Record<string, unknown>, state: Partial<TrackerState> = {}) {
  let current: TrackerState = { ...emptyState(), ...state };
  const tracker = new Tracker({
    llm: {
      complete: async (system) =>
        system.includes("career coach")
          ? '{"company":"Cloudflare","title":"Software Engineer, New Grad","fitScore":77,"strengths":["Python"],"gaps":["Rust"]}'
          : "Dear team, hello.",
    },
    pdf: { toText: async () => "" },
    store: { get: () => current, set: (s) => { current = s; } },
    fetch: fakeFetch(map),
  });
  const req = (route: string, body?: unknown) =>
    tracker.handle(new Request(`${BASE}/${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { req, get: () => current };
}

test("GET companies lists all 40 with readability", async () => {
  const t = setup({});
  const list = (await (await t.req("companies")).json()) as any[];
  assert.equal(list.length, 40);
  assert.equal(list.find((c) => c.id === "google").readable, false);
  assert.equal(list.find((c) => c.id === "anthropic").readable, true);
});

test("discover saves matches, reports counts, and reruns report only new jobs", async () => {
  const map = { "boards/cloudflare/jobs": GREENHOUSE };
  const t = setup(map);
  const r1 = (await (await t.req("discover", { company: "cloudflare" })).json()) as any;
  assert.equal(r1.matched, 2);
  assert.equal(r1.newCount, 2);
  assert.equal(t.get().discovered.length, 2);
  assert.ok(t.get().lastDiscovery.cloudflare);

  const r2 = (await (await t.req("discover", { company: "cloudflare" })).json()) as any;
  assert.equal(r2.newCount, 0);
  assert.equal(t.get().discovered.length, 2);
});

test("discover explains companies that can't be read and boards that fail", async () => {
  const t = setup({});
  const own = await t.req("discover", { company: "google" });
  assert.equal(own.status, 422);
  assert.match(((await own.json()) as any).error, /robots\.txt/);

  const bad = await t.req("discover", { company: "cloudflare" }); // fake fetch returns 404
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as any).error, /Couldn't read Cloudflare/);

  assert.equal((await t.req("discover", { company: "nope" })).status, 404);
});

test("tracking a discovered job analyzes it and refuses duplicates", async () => {
  const map = { "boards/cloudflare/jobs": GREENHOUSE };
  const t = setup(map, { resume: "Jane Doe, engineer. ".repeat(10) });
  await t.req("discover", { company: "cloudflare" });

  const res = await t.req("track", { id: "cloudflare:1" });
  assert.equal(res.status, 200);
  const app = (await res.json()) as any;
  assert.equal(app.fitScore, 77);
  assert.equal(app.url, "https://x/1");
  assert.equal(t.get().applications.length, 1);

  assert.equal((await t.req("track", { id: "cloudflare:1" })).status, 409);
  assert.equal((await t.req("track", { id: "cloudflare:404" })).status, 404);
});

test("bookmarklet import analyzes page text and validates input", async () => {
  const t = setup({}, { resume: "Jane Doe, engineer. ".repeat(10) });
  const text = "Software Engineer, New Grad at Google. ".repeat(10);
  const ok = await t.req("import", { url: "https://www.google.com/about/careers/applications/jobs/results/123", title: "SWE New Grad", text });
  assert.equal(ok.status, 200);
  assert.equal(t.get().applications[0].url, "https://www.google.com/about/careers/applications/jobs/results/123");
  assert.equal((await t.req("import", { url: "https://x.com/1", title: "t", text: "too short" })).status, 422);
  assert.equal((await t.req("import", { url: "javascript:alert(1)", title: "t", text })).status, 400);
  assert.equal((await t.req("import", { url: "nope", title: "t", text })).status, 400);
  assert.equal((await t.req("import", { url: "https://www.google.com/about/careers/applications/jobs/results/123", title: "t", text })).status, 409);
});

test("companies endpoint explains the ones that can't be read", async () => {
  const t = setup({});
  const list = (await (await t.req("companies")).json()) as any[];
  assert.match(list.find((c) => c.id === "meta").note, /written permission/);
  assert.equal(list.find((c) => c.id === "amazon").readable, true);
});

test("tracking needs a resume, and handles a posting that disappeared", async () => {
  const noResume = setup({ "boards/cloudflare/jobs": GREENHOUSE });
  await noResume.req("discover", { company: "cloudflare" });
  assert.equal((await noResume.req("track", { id: "cloudflare:1" })).status, 400);

  const t = setup({ "boards/cloudflare/jobs": GREENHOUSE }, { resume: "Jane Doe, engineer. ".repeat(10) });
  await t.req("discover", { company: "cloudflare" });
  // the board no longer lists job 1
  const gone = { jobs: GREENHOUSE.jobs.filter((j) => j.id !== 1) };
  const t2 = setup({ "boards/cloudflare/jobs": gone }, { ...t.get() });
  assert.equal((await t2.req("track", { id: "cloudflare:1" })).status, 410);
});

test("state saved by an older version still works", async () => {
  const t = setup({});
  // simulate old saved state with no discovery fields
  (t.get() as any).discovered = undefined;
  (t.get() as any).lastDiscovery = undefined;
  const state = (await (await t.req("state")).json()) as any;
  assert.deepEqual(state.discovered, []);
  assert.deepEqual(state.lastDiscovery, {});
});

void body;
