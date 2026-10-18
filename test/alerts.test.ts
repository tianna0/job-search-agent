import test from "node:test";
import assert from "node:assert/strict";
import { filterByLocation, pickNewJobs, renderEmail, updateSeen } from "../src/core/alerts.ts";
import { plistXml, LABEL } from "../src/node/plist.ts";
import type { DiscoveredJob } from "../src/core/discover/discover.ts";

function job(id: string, extra: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    id, externalId: id, company: "stripe", companyName: "Stripe", title: `Software Engineer ${id}`, location: "New York, NY",
    url: `https://stripe.example/${id}`, category: "SWE", level: "entry", reasons: ["title: new grad"], firstSeen: "2026-10-10T00:00:00Z", ...extra,
  };
}

test("pickNewJobs skips jobs already emailed", () => {
  const seen = { jobs: { a: "2026-10-01T00:00:00Z" } };
  assert.deepEqual(pickNewJobs([job("a"), job("b")], seen).map((j) => j.id), ["b"]);
});

test("updateSeen remembers sent jobs, keeps listed ones, forgets old unlisted ones", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const seen = {
    jobs: {
      old_gone: "2026-05-01T00:00:00Z", // 160 days, not listed -> forgotten
      old_listed: "2026-05-01T00:00:00Z", // still listed -> kept
      recent_gone: "2026-10-01T00:00:00Z", // recent -> kept
    },
  };
  const next = updateSeen(seen, [job("new")], [job("old_listed"), job("new")], now);
  assert.deepEqual(Object.keys(next.jobs).sort(), ["new", "old_listed", "recent_gone"]);
  assert.equal(next.jobs.new, "2026-10-11T00:00:00.000Z");
  assert.equal(next.jobs.old_listed, "2026-05-01T00:00:00Z", "first-sent time isn't overwritten");
});

test("filterByLocation keeps matching and unlisted locations; empty keywords keep all", () => {
  const jobs = [job("ny"), job("blr", { location: "Bengaluru, India" }), job("remote", { location: "Remote - US" }), job("none", { location: "" })];
  assert.deepEqual(filterByLocation(jobs, ["New York", " remote "]).map((j) => j.id), ["ny", "remote", "none"]);
  assert.equal(filterByLocation(jobs, [""]).length, 4);
  assert.equal(filterByLocation(jobs, []).length, 4);
});

test("filterByLocation matches whole words and understands US state codes", () => {
  const jobs = [
    job("aarhus", { location: "Aarhus, Denmark" }),
    job("dash", { location: "US-CA-Menlo Park" }),
    job("state", { location: "Seattle, WA" }),
    job("usa", { location: "Newark, New Jersey, USA" }),
    job("toronto", { location: "Toronto, Canada" }),
    job("remote", { location: "Remote in US" }),
    job("ca", { location: "Vancouver, Canada" }),
  ];
  assert.deepEqual(filterByLocation(jobs, ["United States", "USA", "US"]).map((j) => j.id), ["dash", "state", "usa", "remote"]);
});

test("renderEmail groups entry before maybe, escapes HTML, notes failures", () => {
  const jobs = [
    job("m1", { level: "maybe", companyName: "Airbnb", title: "Software Engineer II" }),
    job("e1", { companyName: "Stripe", title: "New Grad <script>" }),
    job("e2", { companyName: "Anthropic", title: "Software Engineer, New Grad" }),
  ];
  const email = renderEmail(jobs, { date: new Date("2026-10-11T13:00:00Z"), failed: ["Apple"] });
  assert.equal(email.subject, "3 new jobs for you (2 entry, 1 maybe) · 2026-10-11");
  const anth = email.text.indexOf("Anthropic"), str = email.text.indexOf("Stripe"), air = email.text.indexOf("Airbnb");
  assert.ok(anth < str && str < air, "entry jobs first, then by company");
  assert.match(email.text, /Couldn't read today: Apple/);
  assert.match(email.html, /New Grad &lt;script&gt;/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /href="https:\/\/stripe\.example\/e1"/);
});

test("renderEmail: first-run wording, singular subject, long lists are cut", () => {
  const one = renderEmail([job("a")], { date: new Date("2026-10-11"), firstRun: true });
  assert.match(one.subject, /^1 new job for you/);
  assert.match(one.text, /First run/);
  const many = renderEmail(Array.from({ length: 230 }, (_, i) => job(`j${i}`)), { date: new Date("2026-10-11") });
  assert.match(many.text, /…and 30 more\./);
});

test("launchd plist runs npm run alerts daily through a login shell", () => {
  const xml = plistXml("/Users/me/Downloads/job tracker's app", 8);
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`));
  assert.match(xml, /<string>\/bin\/zsh<\/string>\s*<string>-lc<\/string>/);
  assert.match(xml, /cd '\/Users\/me\/Downloads\/job tracker'\\''s app' &amp;&amp; npm run alerts &gt;&gt; \.data\/alerts\.log 2&gt;&amp;1/);
  assert.match(xml, /<key>Hour<\/key>\s*<integer>8<\/integer>/);
});

// ---------- ranking ----------
import { chunkText, cosine, jobText, meanVector, parseFitNote, rankJobs } from "../src/core/rank.ts";

test("chunkText splits on lines and keeps pieces under the limit", () => {
  const text = ["a".repeat(50), "b".repeat(50), "c".repeat(50)].join("\n");
  assert.deepEqual(chunkText(text, 110).map((c) => c.length), [101, 50]);
  assert.equal(chunkText("x".repeat(500), 100)[0].length, 100, "one huge line is cut");
  assert.deepEqual(chunkText("  \n\n "), []);
});

test("cosine and meanVector", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.deepEqual(meanVector([[2, 0], [0, 4]]), [0.5, 0.5], "each vector counts equally after normalizing");
});

test("jobText uses the description, or the reasons when there isn't one", () => {
  assert.match(jobText(job("a", { description: "Build payments in Go" })), /Software Engineer a at Stripe\nBuild payments in Go/);
  assert.match(jobText(job("b")), /title: new grad/);
});

test("parseFitNote reads the model's JSON and rejects junk", () => {
  assert.deepEqual(parseFitNote('Sure: {"fit": 140, "why": "Python services", "gap": "No Go"}'), { fit: 100, why: "Python services", gap: "No Go" });
  assert.equal(parseFitNote("no json here"), null);
  assert.equal(parseFitNote('{"fit": 50}'), null, "a note needs a reason");
});

/** Fake embeddings: a text's vector counts the words "python" and "embedded". */
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => [(t.match(/python/gi) ?? []).length + 0.01, (t.match(/embedded/gi) ?? []).length + 0.01]);

test("rankJobs scores by similarity to the resume and writes notes for the top N only", async () => {
  const jobs = [
    job("emb", { title: "Embedded Software Engineer", description: "Embedded C, firmware, embedded Linux" }),
    job("py", { title: "Backend Engineer", description: "Python services, Python data pipelines" }),
    job("mix", { title: "Software Engineer", description: "Python and some embedded work" }),
  ];
  const asked: string[] = [];
  const llm = { complete: async (_s: string, u: string) => { asked.push(u); return '{"fit": 80, "why": "Strong Python", "gap": "No Kafka"}'; } };
  const r = await rankJobs("Python developer. Python, pytest.", jobs, fakeEmbed, llm, 2);
  assert.ok(r.scores.py > r.scores.mix && r.scores.mix > r.scores.emb, JSON.stringify(r.scores));
  assert.deepEqual(Object.keys(r.notes).sort(), ["mix", "py"], "notes for the top 2");
  assert.equal(asked.length, 2);
  assert.match(asked[0], /JOB: Backend Engineer at Stripe/);
});

test("rankJobs: a failed note keeps the score; topN 0 means no model calls", async () => {
  const jobs = [job("py", { description: "Python" })];
  const failing = { complete: async () => { throw new Error("quota"); } };
  const r = await rankJobs("Python", jobs, fakeEmbed, failing, 3);
  assert.ok(r.scores.py > 0);
  assert.deepEqual(r.notes, {});
  let calls = 0;
  await rankJobs("Python", jobs, fakeEmbed, { complete: async () => { calls++; return "{}"; } }, 0);
  assert.equal(calls, 0);
  await assert.rejects(rankJobs("   ", jobs, fakeEmbed, null), /resume is empty/);
});

test("renderEmail with a ranking: top picks with reasons first, then the rest by score", () => {
  const jobs = [job("low", { companyName: "Airbnb" }), job("top", { companyName: "Stripe", level: "maybe" }), job("mid", { companyName: "Reddit" })];
  const email = renderEmail(jobs, {
    date: new Date("2026-10-11T00:00:00Z"),
    ranking: { scores: { low: 41, top: 88, mid: 67 }, notes: { top: { fit: 85, why: "Python <services>", gap: "No Kafka" } } },
  });
  assert.match(email.subject, /best match: Stripe \(88\)/);
  const t = email.text;
  assert.ok(t.indexOf("TOP PICKS") < t.indexOf("[Match 88 · Maybe] Stripe") && t.indexOf("Stripe") < t.indexOf("OTHER NEW JOBS"));
  assert.ok(t.indexOf("[Match 67 · Entry] Reddit") < t.indexOf("[Match 41 · Entry] Airbnb"));
  assert.match(t, /Why: Python <services>\n  Gap: No Kafka/);
  assert.match(email.html, /✓ Python &lt;services&gt;/);
  assert.match(t, /embedding similarity/);
});

test("renderEmail explains when ranking wasn't available", () => {
  const email = renderEmail([job("a")], { date: new Date(), rankingError: "no resume found." });
  assert.match(email.text, /Ranking by resume wasn't available today: no resume found\./);
  assert.match(email.text, /ENTRY LEVEL/, "falls back to grouping by level");
});

// ---------- posting dates ----------
import { firstDate, toIsoDate, workdayPosted } from "../src/core/discover/posted.ts";
import { postedLabel, splitByAge } from "../src/core/alerts.ts";

test("toIsoDate reads epoch seconds/ms, ISO and readable dates; rejects junk", () => {
  assert.equal(toIsoDate(1760000000), "2025-10-09T08:53:20.000Z");
  assert.equal(toIsoDate(1760000000000), "2025-10-09T08:53:20.000Z");
  assert.equal(toIsoDate("1760000000"), "2025-10-09T08:53:20.000Z");
  assert.equal(toIsoDate("2026-10-15T12:00:00Z"), "2026-10-15T12:00:00.000Z");
  assert.ok(toIsoDate("October 10, 2026")?.startsWith("2026-10-1"));
  assert.ok(toIsoDate("Oct 10, 2026")?.startsWith("2026-10-1"));
  for (const bad of [undefined, null, "", "soon", 0, 12, "2999-01-01", {}]) assert.equal(toIsoDate(bad), undefined, String(bad));
  assert.equal(firstDate(undefined, "nope", "2026-10-01T00:00:00Z"), "2026-10-01T00:00:00.000Z");
});

test("workdayPosted understands Today / Yesterday / N Days Ago / 30+ Days Ago", () => {
  const now = Date.parse("2026-10-17T19:00:00Z");
  assert.equal(workdayPosted("Posted Today", now), "2026-10-17T19:00:00.000Z");
  assert.equal(workdayPosted("Posted Yesterday", now), "2026-10-16T19:00:00.000Z");
  assert.equal(workdayPosted("Posted 3 Days Ago", now), "2026-10-14T19:00:00.000Z");
  assert.equal(workdayPosted("Posted 30+ Days Ago", now), "2026-09-17T19:00:00.000Z");
  assert.equal(workdayPosted("", now), undefined);
  assert.equal(workdayPosted(undefined, now), undefined);
});

test("splitByAge keeps recent jobs (with a day of slack), separates old and undated", () => {
  const now = Date.parse("2026-10-17T19:00:00Z");
  const jobs = [
    job("today", { postedAt: "2026-10-17T10:00:00Z" }),
    job("yesterday-date-only", { postedAt: "2026-10-16T05:00:00Z" }), // "October 16" parsed at local midnight
    job("old", { postedAt: "2026-09-01T00:00:00Z" }),
    job("undated"),
  ];
  const r = splitByAge(jobs, 1, now);
  assert.deepEqual(r.recent.map((j) => j.id), ["today", "yesterday-date-only"]);
  assert.deepEqual(r.old.map((j) => j.id), ["old"]);
  assert.deepEqual(r.undated.map((j) => j.id), ["undated"]);
  assert.equal(splitByAge(jobs, 0, now).recent.length, 4, "0 = no age filter");
});

test("emails show the posting date", () => {
  assert.equal(postedLabel(job("a", { postedAt: "2026-10-17T15:00:00Z" }), "America/Chicago"), "Posted Oct 17");
  assert.equal(postedLabel(job("b")), "Posted date not given");
  const email = renderEmail([job("a", { postedAt: "2026-10-17T15:00:00Z" })], { date: new Date("2026-10-17T19:00:00Z"), maxAgeDays: 1, timeZone: "America/Chicago" });
  assert.match(email.text, /Newly posted matching jobs/);
  assert.match(email.text, /Posted Oct 17 · New York, NY/);
  assert.match(email.html, /Posted Oct 17 · Entry/);
});
