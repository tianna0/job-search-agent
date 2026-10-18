import test from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "../src/core/tracker.ts";
import { emptyState, type CatalogSnapshot, type TrackerState } from "../src/core/types.ts";
import { demoState, sanitizeCatalog, SAMPLE_RESUME } from "../src/core/demo.ts";
import { checkPushToken, isDemo, isValidVisitorId } from "../src/cloudflare/demo-gate.ts";
import type { DiscoveredJob } from "../src/core/discover/discover.ts";

const BASE = "http://test/agents/job-tracker/v-0b5e3c2a-1111-4222-8333-444455556666";

function job(n: number, level: "entry" | "maybe" = "entry"): DiscoveredJob {
  return {
    id: `stripe:${n}`, externalId: String(n), company: "stripe", companyName: "Stripe", title: `Software Engineer ${n}`,
    location: "NYC", url: `https://stripe.example/${n}`, category: "SWE", level, reasons: ["title: new grad"], firstSeen: "2026-10-10T00:00:00Z",
  };
}

const SNAPSHOT: CatalogSnapshot = { discovered: [job(1, "maybe"), job(2), job(3)], lastDiscovery: { stripe: "2026-10-10T12:00:00Z" } };

function demoTracker(opts: { state?: Partial<TrackerState>; limit?: number; llm?: () => string } = {}) {
  let state: TrackerState = { ...emptyState(), ...opts.state };
  let snapshots = 0;
  const tracker = new Tracker({
    llm: { complete: async () => (opts.llm ? opts.llm() : "Hi, following up.") },
    pdf: { toText: async () => "" },
    store: { get: () => state, set: (s) => { state = s; } },
    aiDailyLimit: opts.limit ?? 25,
    demoSnapshot: async () => { snapshots++; return SNAPSHOT; },
  });
  const req = (route: string, body?: unknown) =>
    tracker.handle(new Request(`${BASE}/${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { tracker, req, get: () => state, snapshots: () => snapshots, set: (s: TrackerState) => { state = s; } };
}

test("demoState: fictional resume, the shared jobs, one sample application waiting for a follow-up", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const s = demoState(SNAPSHOT, now);
  assert.equal(s.resume, SAMPLE_RESUME);
  assert.match(s.resumeName, /fictional/);
  assert.equal(s.discovered.length, 3);
  const app = s.applications[0];
  assert.equal(app.sample, true);
  assert.equal(app.company, "Stripe");
  assert.equal(app.title, "Software Engineer 2", "uses the first entry-level job");
  assert.equal(app.status, "applied");
  assert.equal(Math.round((now - Date.parse(app.updatedAt)) / 86_400_000), 18);
  assert.ok(s.demoSeededAt);
});

test("demoState with an empty catalog still gives a usable sample application", () => {
  const s = demoState({ discovered: [], lastDiscovery: {} });
  assert.equal(s.applications[0].company, "Example Corp");
});

test("first request seeds the visitor's copy once; reset reseeds", async () => {
  const t = demoTracker();
  const state = (await (await t.req("state")).json()) as TrackerState;
  assert.equal(state.discovered.length, 3);
  assert.equal(state.applications[0].sample, true);
  await t.req("state");
  assert.equal(t.snapshots(), 1, "not reseeded on later requests");

  await t.req("status", { id: "sample-application", status: "offer" });
  assert.equal(t.get().applications[0].status, "offer");
  const reset = (await (await t.req("demo-reset", {})).json()) as TrackerState;
  assert.equal(reset.applications[0].status, "applied");
});

test("info says demo and the AI limit", async () => {
  const info = (await (await demoTracker({ limit: 7 }).req("info")).json()) as any;
  assert.equal(info.demo, true);
  assert.equal(info.aiDailyLimit, 7);
  assert.equal(info.canScan, false);
});

test("demo follow-ups: the sample application gets a draft", async () => {
  const t = demoTracker();
  await t.req("state");
  assert.deepEqual(await t.tracker.staleApplicationIds(), ["sample-application"]);
  const r = (await (await t.req("follow-ups", {})).json()) as any;
  assert.equal(r.drafted, 1);
  assert.match(t.get().applications[0].followUp!.text, /following up/);
});

test("AI cap: calls stop at the daily limit and reset the next day", async () => {
  const replies = () => '{"reply":"hello"}';
  const t = demoTracker({ limit: 2, llm: replies });
  await t.req("state");
  assert.equal((await t.req("chat", { message: "hi" })).status, 200);
  assert.equal((await t.req("chat", { message: "hi again" })).status, 200);
  const blocked = await t.req("chat", { message: "one more" });
  assert.equal(blocked.status, 429);
  assert.match(((await blocked.json()) as any).error, /2 AI calls per visitor per day/);

  t.set({ ...t.get(), aiUsage: { day: "2000-01-01", calls: 99 } });
  assert.equal((await t.req("chat", { message: "next day" })).status, 200);
  assert.equal(t.get().aiUsage!.calls, 1);
});

test("no AI cap and no demo routes in the private app", async () => {
  let state = emptyState();
  let calls = 0;
  const t = new Tracker({
    llm: { complete: async () => { calls++; return '{"reply":"ok"}'; } },
    pdf: { toText: async () => "" },
    store: { get: () => state, set: (s) => { state = s; } },
  });
  for (let i = 0; i < 30; i++) {
    await t.handle(new Request(`${BASE}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":"hi"}' }));
  }
  assert.equal(calls, 30);
  assert.equal(state.aiUsage, null);
  const reset = await t.handle(new Request(`${BASE}/demo-reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(reset.status, 404);
});

test("catalog: replace keeps only well-formed jobs, snapshot returns them", async () => {
  let state = emptyState();
  const catalog = new Tracker({ llm: { complete: async () => "" }, pdf: { toText: async () => "" }, store: { get: () => state, set: (s) => { state = s; } } });
  const r = await catalog.replaceCatalog({
    jobs: [
      job(1),
      { ...job(2), url: "javascript:alert(1)" },
      { ...job(3), level: "excluded" },
      { ...job(4), title: "" },
      { ...job(5), title: "x".repeat(5000) },
      "garbage",
    ],
    lastDiscovery: { stripe: "2026-10-10T12:00:00Z", bad: 42 },
  });
  assert.equal(r.jobs, 2);
  const snap = await catalog.catalogSnapshot();
  assert.deepEqual(snap.discovered.map((j) => j.id), ["stripe:1", "stripe:5"]);
  assert.equal(snap.discovered[1].title.length, 300);
  assert.deepEqual(snap.lastDiscovery, { stripe: "2026-10-10T12:00:00Z" });
  assert.deepEqual(sanitizeCatalog(null), { discovered: [], lastDiscovery: {} });
});

test("demo gate: visitor ids, demo flag, push token", () => {
  assert.equal(isValidVisitorId("v-0b5e3c2a-1111-4222-8333-444455556666"), true);
  for (const bad of ["catalog", "default", "v-123", "../catalog", "V-0B5E3C2A-1111-4222-8333-444455556666"]) {
    assert.equal(isValidVisitorId(bad), false, bad);
  }
  assert.equal(isDemo({ DEMO_MODE: "1" }), true);
  assert.equal(isDemo({}), false);

  const req = (auth?: string) => new Request("http://x/api/push-jobs", { method: "POST", headers: auth ? { authorization: auth } : {} });
  const secret = "a-long-random-secret-123";
  assert.equal(checkPushToken(req(`Bearer ${secret}`), undefined)!.status, 503, "no secret set");
  assert.equal(checkPushToken(req("Bearer short"), "short")!.status, 503, "secret too short");
  assert.equal(checkPushToken(req(), secret)!.status, 401);
  assert.equal(checkPushToken(req("Bearer wrong-wrong-wrong-wrong"), secret)!.status, 401);
  assert.equal(checkPushToken(req(`Bearer ${secret}`), secret), null);
});
