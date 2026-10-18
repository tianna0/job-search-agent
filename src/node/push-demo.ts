// Pushes the jobs from your local scan into the public demo, so every visitor
// sees real, current postings. Run after a local scan:
//   npm run push-demo
// Needs DEMO_URL and DEMO_PUSH_TOKEN in .env (see .env.example).
import { existsSync, readFileSync } from "node:fs";

const url = process.env.DEMO_URL?.replace(/\/+$/, "");
const token = process.env.DEMO_PUSH_TOKEN;
const file = new URL("../../.data/state.json", import.meta.url);

if (!url || !token) {
  console.error("Set DEMO_URL and DEMO_PUSH_TOKEN in .env first (see .env.example).");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error("No local data yet. Run npm run local and scan first.");
  process.exit(1);
}

const state = JSON.parse(readFileSync(file, "utf8"));
const jobs = state.discovered ?? [];
if (!jobs.length) {
  console.error("Your local app has no found jobs. Click 'Scan all companies now' first.");
  process.exit(1);
}

const res = await fetch(`${url}/api/push-jobs`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ jobs, lastDiscovery: state.lastDiscovery ?? {} }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Push failed (HTTP ${res.status}): ${body.error ?? "unknown error"}`);
  process.exit(1);
}
console.log(`Pushed ${body.jobs} jobs to ${url}. New demo visitors (and anyone who clicks "Reset demo") will see them.`);
