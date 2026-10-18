import test from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "../src/core/tracker.ts";
import { emptyState, type TrackerState } from "../src/core/types.ts";
import { runFollowUpSteps, type FollowUpAgentApi, type StepRunner } from "../src/core/followup-workflow.ts";
import { dailyDue } from "../src/core/daily.ts";
import { runChat, type ChatTools } from "../src/core/chat.ts";
import { checkAccess, clearAccessKeyCache, normalizeTeamDomain, verifyAccessJwt } from "../src/cloudflare/access.ts";
import type { DiscoveredJob } from "../src/core/discover/discover.ts";

const BASE = "http://test/agents/job-tracker/default";
const RESUME = "Jane Doe, SDET with Python and Playwright. ".repeat(6);

function job(company: string, n: number, extra: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    id: `${company}:${n}`, externalId: String(n), company, companyName: company[0].toUpperCase() + company.slice(1),
    title: `Software Engineer, New Grad ${n}`, location: "NYC", url: `https://${company}.example/${n}`,
    category: "SWE", level: "entry", reasons: ["title: new grad"], firstSeen: "2026-10-01T00:00:00Z", ...extra,
  };
}

function makeTracker(opts: { state?: Partial<TrackerState>; llm?: (system: string, user: string) => string; startScan?: () => Promise<{ id: string }>; fetch?: typeof fetch } = {}) {
  let state: TrackerState = { ...emptyState(), ...opts.state };
  const calls: string[] = [];
  const tracker = new Tracker({
    llm: { complete: async (s, u) => { calls.push(u); return opts.llm ? opts.llm(s, u) : "{}"; } },
    pdf: { toText: async () => "" },
    store: { get: () => state, set: (s) => { state = s; } },
    startScan: opts.startScan as any,
    fetch: opts.fetch,
  });
  const post = (route: string, body: unknown) =>
    tracker.handle(new Request(`${BASE}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { tracker, post, get: () => state, calls };
}

// ---------- scan progress ----------

test("scan progress: start is idempotent, results merge, failures recorded, finish", async () => {
  const t = makeTracker();
  await t.tracker.scanStarted("s1", "manual", ["stripe", "reddit", "apple"]);
  await t.tracker.scanStarted("s1", "cron", ["x"]); // second call ignored
  assert.deepEqual(t.get().scan!.companies, ["stripe", "reddit", "apple"]);
  assert.equal(t.get().scan!.trigger, "manual");

  const r1 = await t.tracker.recordScanResult("s1", "stripe", { ok: true, matched: [job("stripe", 1), job("stripe", 2)] });
  assert.deepEqual(r1, { matched: 2, newCount: 2 });
  await t.tracker.recordScanResult("s1", "stripe", { ok: true, matched: [job("stripe", 1), job("stripe", 2)] }); // retried step
  await t.tracker.recordScanResult("s1", "apple", { ok: false, error: "HTTP 500" });

  const s = t.get().scan!;
  assert.deepEqual(s.done, ["stripe", "apple"], "a repeated company counts once");
  assert.equal(s.matched, 2);
  assert.equal(s.newJobs, 2);
  assert.deepEqual(s.failed, [{ company: "apple", error: "HTTP 500" }]);
  assert.equal(t.get().discovered.length, 2);
  assert.ok(t.get().lastDiscovery.stripe);

  await t.tracker.scanFinished("s1");
  assert.ok(t.get().scan!.finishedAt);
});

test("results from an old scan still save jobs but don't touch the current scan", async () => {
  const t = makeTracker();
  await t.tracker.scanStarted("new", "manual", ["stripe"]);
  await t.tracker.recordScanResult("old", "stripe", { ok: true, matched: [job("stripe", 1)] });
  assert.equal(t.get().discovered.length, 1);
  assert.deepEqual(t.get().scan!.done, []);
});

test("POST scan starts through the platform and refuses a second running scan", async () => {
  let started = 0;
  const t = makeTracker({ startScan: async () => ({ id: `s${++started}` }) });
  const first = await t.post("scan", {});
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { id: "s1" });

  await t.tracker.scanStarted("s1", "manual", ["stripe"]);
  assert.equal((await t.post("scan", {})).status, 409);

  await t.tracker.scanFinished("s1");
  assert.equal((await t.post("scan", {})).status, 200);
  assert.equal(started, 2);
});

test("a scan stuck for hours doesn't block a new one", async () => {
  const t = makeTracker({
    startScan: async () => ({ id: "fresh" }),
    state: { scan: { id: "stuck", trigger: "cron", startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), companies: ["a"], done: [], failed: [], matched: 0, newJobs: 0 } },
  });
  assert.equal((await t.post("scan", {})).status, 200);
});

test("POST scan without a scan runner explains it", async () => {
  const t = makeTracker();
  const res = await t.post("scan", {});
  assert.equal(res.status, 501);
  assert.match(((await res.json()) as any).error, /local version/);
});

test("scanCompany never throws: unreadable and failing companies are recorded", async () => {
  const t = makeTracker({ fetch: (async () => new Response("down", { status: 500 })) as typeof fetch });
  await t.tracker.scanStarted("s", "manual", ["google", "stripe"]);
  assert.match((await t.tracker.scanCompany("s", "google")).error!, /Not readable/);
  assert.match((await t.tracker.scanCompany("s", "stripe")).error!, /HTTP 500/);
  assert.equal(t.get().scan!.failed.length, 2);
});

// ---------- follow-ups ----------

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
function app(id: string, status: string, updatedDaysAgo: number, extra: Record<string, unknown> = {}) {
  return { id, url: `https://x/${id}`, company: `Co ${id}`, title: "SWE", status: status as any, fitScore: 70, strengths: [], gaps: [], coverLetter: "", createdAt: daysAgo(updatedDaysAgo), updatedAt: daysAgo(updatedDaysAgo), ...extra };
}

test("follow-ups: only 'applied' for 14+ days, and not again within 14 days of a draft", async () => {
  const t = makeTracker({
    state: {
      resume: RESUME,
      applications: [
        app("a", "applied", 20),
        app("b", "applied", 5),
        app("c", "interviewing", 30),
        app("d", "applied", 40, { followUp: { text: "old", draftedAt: daysAgo(3) } }),
        app("e", "applied", 40, { followUp: { text: "old", draftedAt: daysAgo(20) } }),
      ],
    },
  });
  assert.deepEqual(await t.tracker.staleApplicationIds(), ["a", "e"]);
});

test("follow-ups: draft is saved on the application without resetting its age", async () => {
  const t = makeTracker({ state: { resume: RESUME, applications: [app("a", "applied", 20)] }, llm: () => "Hi,\nJust following up on my application." });
  const before = t.get().applications[0].updatedAt;
  await t.tracker.draftFollowUp("a");
  const a = t.get().applications[0];
  assert.match(a.followUp!.text, /following up/);
  assert.equal(a.updatedAt, before);
  assert.match(t.calls[0], /Applied about 20 days ago/);
  assert.match(t.calls[0], /Jane Doe/);
});

test("follow-ups route: inline locally, records the run, survives one failure", async () => {
  let n = 0;
  const t = makeTracker({
    state: { resume: RESUME, applications: [app("a", "applied", 20), app("b", "applied", 30)] },
    llm: () => (++n === 1 ? "" : "Hi, following up."),
  });
  const res = await t.post("follow-ups", {});
  assert.deepEqual(await res.json(), { drafted: 1, failed: 1 });
  assert.equal(t.get().followUps!.drafted, 1);
  assert.ok(t.get().followUps!.lastRunAt);
});

test("follow-ups route: uses the background runner when the platform has one", async () => {
  let started = false;
  let state: TrackerState = { ...emptyState(), applications: [app("a", "applied", 20)] as any };
  const tracker = new Tracker({
    llm: { complete: async () => { throw new Error("should not draft inline"); } },
    pdf: { toText: async () => "" },
    store: { get: () => state, set: (s) => { state = s; } },
    startFollowUps: async () => { started = true; return { id: "wf-1" }; },
  });
  const res = await tracker.handle(new Request(`${BASE}/follow-ups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.deepEqual(await res.json(), { started: "wf-1" });
  assert.ok(started);
});

function fakeStep(opts: { failSteps?: Set<string> } = {}) {
  const names: string[] = [];
  const step: StepRunner = {
    async do(name, _config, fn) {
      names.push(name);
      if (opts.failSteps?.has(name)) throw new Error("retries exhausted");
      return fn();
    },
  };
  return { step, names };
}

function followUpAgent(t: ReturnType<typeof makeTracker>) {
  const api: FollowUpAgentApi = {
    staleApplicationIds: () => t.tracker.staleApplicationIds(),
    draftFollowUp: (id) => t.tracker.draftFollowUp(id),
    followUpsDone: (n) => t.tracker.followUpsDone(n),
  };
  return async () => api;
}

test("follow-up workflow: one step per stale application, then a finish step", async () => {
  const t = makeTracker({ state: { resume: RESUME, applications: [app("a", "applied", 20), app("b", "applied", 2), app("c", "applied", 15)] }, llm: () => "Hi, following up." });
  const { step, names } = fakeStep();
  const r = await runFollowUpSteps(step, followUpAgent(t));
  assert.deepEqual(names, ["find stale applications", "draft follow-up a", "draft follow-up c", "finish"]);
  assert.deepEqual(r, { checked: 2, drafted: 2, failed: [] });
  assert.ok(t.get().applications.find((x) => x.id === "a")!.followUp);
  assert.ok(!t.get().applications.find((x) => x.id === "b")!.followUp);
  assert.equal(t.get().followUps!.drafted, 2);
});

test("follow-up workflow: a step that fails after retries is skipped, the rest continue", async () => {
  const t = makeTracker({ state: { resume: RESUME, applications: [app("a", "applied", 20), app("c", "applied", 15)] }, llm: () => "Hi." });
  const { step, names } = fakeStep({ failSteps: new Set(["draft follow-up a"]) });
  const r = await runFollowUpSteps(step, followUpAgent(t));
  assert.deepEqual(r.failed, ["a"]);
  assert.equal(r.drafted, 1);
  assert.equal(names.at(-1), "finish");
});

// ---------- daily timer (local server) ----------

test("dailyDue: runs once a day after the hour, local time", () => {
  const at = (h: number, m = 0, d = 11) => new Date(2026, 9, d, h, m);
  assert.equal(dailyDue(null, at(7, 59), 8), false, "too early");
  assert.equal(dailyDue(null, at(8, 0), 8), true, "never ran");
  assert.equal(dailyDue(at(8, 5).toISOString(), at(15), 8), false, "already ran today");
  assert.equal(dailyDue(at(7, 30).toISOString(), at(9), 8), true, "ran before today's hour");
  assert.equal(dailyDue(at(9, 0, 10).toISOString(), at(9), 8), true, "ran yesterday");
  assert.equal(dailyDue("garbage", at(9), 8), true);
});

// ---------- chat ----------

/** An LLM that answers from a script, one reply per call. */
function scripted(replies: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    llm: { complete: async (_s: string, u: string) => { prompts.push(u); return replies.shift() ?? '{"reply":"(script ended)"}'; } },
  };
}

function toolsFor(state: TrackerState, overrides: Partial<ChatTools> = {}): ChatTools {
  return {
    getState: async () => state,
    trackDiscovered: async () => { throw new Error("not expected"); },
    setStatus: async () => ({}),
    reviseCoverLetter: async () => { throw new Error("not expected"); },
    startScan: async () => ({ id: "s" }),
    draftFollowUps: async () => ({ drafted: 0, failed: 0 }),
    ...overrides,
  };
}

test("chat: calls a tool, sees the result, then replies", async () => {
  const state = { ...emptyState(), discovered: [job("stripe", 1), job("reddit", 2, { level: "maybe" })] };
  const s = scripted(['{"tool":"list_jobs","args":{"level":"entry"}}', '{"reply":"Stripe has a new grad role."}']);
  const reply = await runChat(s.llm, toolsFor(state), [], "Any entry-level jobs?");
  assert.equal(reply, "Stripe has a new grad role.");
  assert.match(s.prompts[1], /list_jobs\(\{"level":"entry"\}\) -> \{"total":1/);
  assert.match(s.prompts[1], /"job_id":"stripe:1"/);
  assert.doesNotMatch(s.prompts[1], /reddit:2/, "filtered out the maybe job");
});

test("chat: list_jobs hides jobs already in the tracker and filters by company name", async () => {
  const state = {
    ...emptyState(),
    discovered: [job("stripe", 1), job("stripe", 2), job("reddit", 3)],
    applications: [{ id: "a", url: "https://stripe.example/1", company: "Stripe", title: "t", status: "saved" as const, fitScore: 1, strengths: [], gaps: [], coverLetter: "", createdAt: "", updatedAt: "" }],
  };
  const s = scripted(['{"tool":"list_jobs","args":{"company":"stripe"}}', '{"reply":"ok"}']);
  await runChat(s.llm, toolsFor(state), [], "stripe jobs?");
  assert.match(s.prompts[1], /"total":1/);
  assert.match(s.prompts[1], /stripe:2/);
});

test("chat: plain-text model output is used as the reply", async () => {
  const s = scripted(["Sure! Here is my answer without JSON."]);
  assert.equal(await runChat(s.llm, toolsFor(emptyState()), [], "hi"), "Sure! Here is my answer without JSON.");
});

test("chat: tool errors go back to the model instead of crashing", async () => {
  const s = scripted(['{"tool":"add_job","args":{"job_id":"nope"}}', '{"tool":"teleport","args":{}}', '{"reply":"That job id was not found."}']);
  const tools = toolsFor(emptyState(), { trackDiscovered: async () => { throw new Error("Job not found. Run discovery again."); } });
  const reply = await runChat(s.llm, tools, [], "add job nope");
  assert.equal(reply, "That job id was not found.");
  assert.match(s.prompts[1], /"error":"Job not found/);
  assert.match(s.prompts[2], /Unknown tool \\"teleport\\"/);
});

test("chat: stops after a few steps if the model keeps calling tools", async () => {
  const s = scripted(Array(10).fill('{"tool":"scan_status","args":{}}'));
  const reply = await runChat(s.llm, toolsFor(emptyState()), [], "loop");
  assert.match(reply, /couldn't finish/);
  assert.equal(s.prompts.length, 5);
});

test("chat route: tools change real state, history is saved and capped", async () => {
  const appBase = { url: "https://stripe.example/1", company: "Stripe", title: "SWE", status: "saved" as const, fitScore: 70, strengths: [], gaps: [], coverLetter: "Old letter", createdAt: "", updatedAt: "" };
  const replies = [
    '{"tool":"update_status","args":{"application_id":"a1","status":"applied"}}',
    '{"tool":"revise_cover_letter","args":{"application_id":"a1","instructions":"mention Playwright"}}',
    '{"reply":"Done: marked applied and updated the letter."}',
  ];
  const t = makeTracker({
    state: { resume: RESUME, applications: [{ ...appBase, id: "a1" }], chat: Array.from({ length: 29 }, (_, i) => ({ role: "user" as const, text: `old ${i}`, at: "" })) },
    llm: (system) => (system.startsWith("You revise cover letters") ? "New letter mentioning Playwright." : replies.shift()!),
  });
  const res = await t.post("chat", { message: "I applied to Stripe; also mention Playwright in the letter" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.reply, "Done: marked applied and updated the letter.");
  const app = t.get().applications[0];
  assert.equal(app.status, "applied");
  assert.equal(app.coverLetter, "New letter mentioning Playwright.");
  assert.equal(t.get().chat.length, 30, "history capped at 30");
  assert.equal(t.get().chat.at(-1)!.role, "assistant");
  assert.equal((await t.post("chat", { message: "  " })).status, 400);
  await t.post("chat-reset", {});
  assert.deepEqual(t.get().chat, []);
});

test("chat route: start_scan uses the platform scan runner", async () => {
  let started = false;
  const replies = ['{"tool":"start_scan","args":{}}', '{"reply":"Scan started."}'];
  const t = makeTracker({ llm: () => replies.shift()!, startScan: async () => { started = true; return { id: "c1" }; } });
  const body = (await (await t.post("chat", { message: "scan now" })).json()) as any;
  assert.equal(body.reply, "Scan started.");
  assert.ok(started);
});

test("chat: get_follow_up and list_applications show follow-up info", async () => {
  const state = { ...emptyState(), applications: [app("a", "applied", 20, { followUp: { text: "Hi, checking in.", draftedAt: daysAgo(1) } })] as any };
  const s = scripted(['{"tool":"list_applications","args":{}}', '{"tool":"get_follow_up","args":{"application_id":"a"}}', '{"reply":"Here it is."}']);
  await runChat(s.llm, toolsFor(state), [], "show my follow-up");
  assert.match(s.prompts[1], /"days_since_update":20,"has_follow_up_draft":true/);
  assert.match(s.prompts[2], /"email":"Hi, checking in."/);
});

test("chat: draft_follow_ups runs through the tracker", async () => {
  let called = false;
  const s = scripted(['{"tool":"draft_follow_ups","args":{}}', '{"reply":"Drafted 1."}']);
  await runChat(s.llm, toolsFor(emptyState(), { draftFollowUps: async () => { called = true; return { drafted: 1, failed: 0 }; } }), [], "draft follow-ups");
  assert.ok(called);
  assert.match(s.prompts[1], /\{"drafted":1,"failed":0\}/);
});

test("info route tells the page whether scanning is available here", async () => {
  const local = makeTracker({ startScan: async () => ({ id: "x" }) });
  const cloud = makeTracker();
  const info = async (t: ReturnType<typeof makeTracker>) => (await t.tracker.handle(new Request(`${BASE}/info`))).json() as Promise<any>;
  assert.equal((await info(local)).canScan, true);
  assert.equal((await info(cloud)).canScan, false);
  assert.equal((await info(cloud)).followUpAfterDays, 14);
});

// ---------- Cloudflare Access ----------

const TEAM = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function keyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string };
  return { pair, jwk: { ...jwk, kid: "k1", alg: "RS256", use: "sig" } };
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid = "k1") {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

test("Access: team domain accepts short and full forms", () => {
  assert.equal(normalizeTeamDomain("myteam"), TEAM);
  assert.equal(normalizeTeamDomain("myteam.cloudflareaccess.com"), TEAM);
  assert.equal(normalizeTeamDomain("https://myteam.cloudflareaccess.com/"), TEAM);
});

test("Access: valid token passes; wrong audience, issuer, expiry, signature, key all fail", async () => {
  clearAccessKeyCache();
  const { pair, jwk } = await keyPair();
  const other = await keyPair();
  let certCalls = 0;
  const certs = (async (url: any) => {
    certCalls++;
    assert.equal(String(url), `${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const now = Date.now();
  const good = { iss: TEAM, aud: [AUD], email: "me@example.com", exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) };

  const payload = await verifyAccessJwt(await sign(pair.privateKey, good), { teamDomain: "myteam", aud: AUD }, certs, now);
  assert.equal(payload.email, "me@example.com");

  const bad = async (token: string, msg: RegExp) =>
    assert.rejects(verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD }, certs, now), msg);
  await bad(await sign(pair.privateKey, { ...good, aud: ["someone-else"] }), /audience/);
  await bad(await sign(pair.privateKey, { ...good, iss: "https://evil.cloudflareaccess.com" }), /issuer/);
  await bad(await sign(pair.privateKey, { ...good, exp: Math.floor(now / 1000) - 3600 }), /expired/);
  await bad(await sign(other.pair.privateKey, good), /signature/);
  await bad(await sign(pair.privateKey, good, "unknown-kid"), /unknown signing key/);
  await bad("not.a.jwt.at.all", /malformed/);
  assert.ok(certCalls <= 3, "keys are cached, refetched only for an unknown key id");
});

test("Access: checkAccess is open when not configured and closed when configured", async () => {
  clearAccessKeyCache();
  const { pair, jwk } = await keyPair();
  const certs = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch;
  const req = (token?: string) => new Request(`${BASE}/state`, { headers: token ? { "cf-access-jwt-assertion": token } : {} });

  assert.equal(await checkAccess(req(), {}), null, "no config: public");
  assert.equal((await checkAccess(req(), { TEAM_DOMAIN: TEAM }))!.status, 500, "half configured fails closed");
  assert.equal((await checkAccess(req(), { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD }, certs))!.status, 403, "no token");
  assert.equal((await checkAccess(req("garbage"), { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD }, certs))!.status, 403);

  const token = await sign(pair.privateKey, { iss: TEAM, aud: AUD, exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(await checkAccess(req(token), { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD }, certs), null);
});
