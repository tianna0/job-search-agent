import test from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "../src/core/tracker.ts";
import { htmlToText } from "../src/core/jobpage.ts";
import { extractJson, llmText } from "../src/core/util.ts";
import { emptyState, type TrackerState } from "../src/core/types.ts";

const BASE = "http://test/agents/job-tracker/default";
const RESUME_TEXT = "Jane Doe, software engineer in test. ".repeat(10);
const PAGE =
  "<html><head><title>Backend Engineer at Acme</title><script>evil()</script></head><body>" +
  "<p>We build payment systems and need strong Python and testing skills.</p>".repeat(8) +
  "</body></html>";

function setup(overrides: { page?: Response; llmReply?: (system: string) => string } = {}) {
  let state: TrackerState = emptyState();
  const prompts: string[] = [];
  const tracker = new Tracker({
    llm: {
      complete: async (system, user) => {
        prompts.push(user);
        if (overrides.llmReply) return overrides.llmReply(system);
        return system.includes("career coach")
          ? 'Sure! {"company":"Acme","title":"Backend Engineer","fitScore":82,"strengths":["Testing"],"gaps":["Go"]}'
          : "Dear Acme, I would love to join.";
      },
    },
    pdf: { toText: async () => RESUME_TEXT },
    store: { get: () => state, set: (s) => { state = s; } },
    fetch: async () =>
      overrides.page ?? new Response(PAGE, { headers: { "content-type": "text/html" } }),
  });
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    tracker.handle(
      new Request(`${BASE}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  const upload = (bytes: Uint8Array) =>
    tracker.handle(
      new Request(`${BASE}/resume`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent("My Résumé.pdf") },
        body: bytes,
      })
    );
  return { tracker, post, upload, prompts, getState: () => state };
}

const FAKE_PDF = new TextEncoder().encode("%PDF-1.4 fake body");

test("htmlToText drops scripts and keeps the title", () => {
  const text = htmlToText(PAGE);
  assert.match(text, /Page title: Backend Engineer at Acme/);
  assert.match(text, /payment systems/);
  assert.doesNotMatch(text, /evil/);
});

test("uploading a PDF stores the extracted text and the file name", async () => {
  const t = setup();
  const res = await t.upload(FAKE_PDF);
  assert.equal(res.status, 200);
  assert.equal(t.getState().resumeName, "My Résumé.pdf");
  assert.match(t.getState().resume, /Jane Doe/);
});

test("rejects files that are not PDFs and empty files", async () => {
  const t = setup();
  assert.equal((await t.upload(new TextEncoder().encode("hello world"))).status, 400);
  assert.equal((await t.upload(new Uint8Array())).status, 400);
});

test("adding a job needs a resume first", async () => {
  const t = setup();
  const res = await t.post("apply", { url: "https://acme.com/jobs/1" });
  assert.equal(res.status, 400);
});

test("full flow: upload, add job from a link, change status", async () => {
  const t = setup();
  await t.upload(FAKE_PDF);

  const res = await t.post("apply", { url: "https://acme.com/jobs/1" });
  assert.equal(res.status, 200);
  const app = (await res.json()) as any;
  assert.equal(app.company, "Acme");
  assert.equal(app.title, "Backend Engineer");
  assert.equal(app.fitScore, 82);
  assert.equal(app.status, "saved");
  assert.match(app.coverLetter, /Dear Acme/);
  assert.match(t.prompts[0], /Jane Doe/);
  assert.match(t.prompts[0], /payment systems/);

  const upd = await t.post("status", { id: app.id, status: "applied" });
  assert.equal(upd.status, 200);
  assert.equal(t.getState().applications[0].status, "applied");

  assert.equal((await t.post("status", { id: app.id, status: "bogus" })).status, 400);
  assert.equal((await t.post("status", { id: "nope", status: "offer" })).status, 404);
});

test("bad links and unreadable pages give clear errors", async () => {
  const t = setup();
  await t.upload(FAKE_PDF);
  assert.equal((await t.post("apply", { url: "not a url" })).status, 400);
  assert.equal((await t.post("apply", { url: "ftp://acme.com/x" })).status, 400);

  const thin = setup({ page: new Response("<html><body>Please log in</body></html>", { headers: { "content-type": "text/html" } }) });
  await thin.upload(FAKE_PDF);
  const res = await thin.post("apply", { url: "https://acme.com/jobs/1" });
  assert.equal(res.status, 422);

  const blocked = setup({ page: new Response("no", { status: 403 }) });
  await blocked.upload(FAKE_PDF);
  assert.equal((await blocked.post("apply", { url: "https://acme.com/jobs/1" })).status, 422);
});

test("a garbled model answer is reported, not stored", async () => {
  const t = setup({ llmReply: () => "I cannot do that." });
  await t.upload(FAKE_PDF);
  const res = await t.post("apply", { url: "https://acme.com/jobs/1" });
  assert.equal(res.status, 502);
  assert.equal(t.getState().applications.length, 0);
});

test("llmText turns an already-parsed object into a JSON string", () => {
  assert.equal(llmText("plain"), "plain");
  assert.equal(llmText(null), "");
  assert.equal(llmText({ a: 1 }), '{"a":1}');
  assert.deepEqual(extractJson(llmText({ fitScore: 70 })), { fitScore: 70 });
});

test("Greenhouse links are read through the public JSON API", async () => {
  const urls: string[] = [];
  const t = setup();
  const tracker = new Tracker({
    llm: { complete: async (s, u) => {
      urls.push(u);
      return s.includes("career coach")
        ? '{"company":"Cloudflare","title":"Systems Engineer","fitScore":70,"strengths":[],"gaps":[]}'
        : "letter";
    } },
    pdf: { toText: async () => RESUME_TEXT },
    store: { get: () => t.getState(), set: () => {} },
    fetch: async (input: any) => {
      const u = String(input);
      assert.match(u, /boards-api\.greenhouse\.io\/v1\/boards\/cloudflare\/jobs\/8264664/);
      return new Response(
        JSON.stringify({
          title: "Systems Engineer",
          location: { name: "Austin, TX" },
          content: "&lt;p&gt;" + "You will build edge systems in Rust. ".repeat(12) + "&lt;/p&gt;",
        }),
        { headers: { "content-type": "application/json" } }
      );
    },
  });
  // seed a resume into the shared test state
  await t.upload(FAKE_PDF);
  const res = await tracker.handle(
    new Request(`${BASE}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://job-boards.greenhouse.io/cloudflare/jobs/8264664?gh_jid=8264664" }),
    })
  );
  assert.equal(res.status, 200);
  assert.match(urls[0], /edge systems in Rust/);
  assert.match(urls[0], /Austin, TX/);
  assert.doesNotMatch(urls[0], /&lt;|<p>/);
});

test("fit score is clamped to 0-100", async () => {
  const t = setup({
    llmReply: (s) =>
      s.includes("career coach")
        ? '{"company":"Acme","title":"X","fitScore":250,"strengths":[],"gaps":[]}'
        : "letter",
  });
  await t.upload(FAKE_PDF);
  const app = (await (await t.post("apply", { url: "https://acme.com/jobs/1" })).json()) as any;
  assert.equal(app.fitScore, 100);
});
