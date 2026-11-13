import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAlerts } from "../src/cloudflare/trigger.ts";

const env = { GITHUB_TOKEN: "t0k", GITHUB_REPO: "me/job-search-agent" };

test("trigger: dispatches the alerts workflow in scheduled mode", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  await dispatchAlerts(env, async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 204 });
  });
  assert.ok(seen);
  const { url, init } = seen as { url: string; init: RequestInit };
  assert.equal(url, "https://api.github.com/repos/me/job-search-agent/actions/workflows/alerts.yml/dispatches");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer t0k");
  assert.deepEqual(JSON.parse(String(init.body)), { ref: "main", inputs: { mode: "scheduled" } });
});

test("trigger: reports GitHub's refusal", async () => {
  await assert.rejects(
    dispatchAlerts(env, async () => new Response('{"message":"Bad credentials"}', { status: 401 })),
    /HTTP 401.*Bad credentials/
  );
});

test("trigger: needs a token and an owner/name repo", async () => {
  const never = async () => assert.fail("should not fetch");
  await assert.rejects(dispatchAlerts({ GITHUB_REPO: "me/x" }, never), /GITHUB_TOKEN/);
  await assert.rejects(dispatchAlerts({ GITHUB_TOKEN: "t", GITHUB_REPO: "nope" }, never), /owner\/name/);
});
