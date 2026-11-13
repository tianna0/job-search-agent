// A tiny Cloudflare Worker whose only job is to start the "Job alerts" GitHub
// Actions workflow on time. GitHub's own cron often starts scheduled runs hours
// late; Cloudflare Cron Triggers fire within about a minute, and they are free
// on the Workers Free plan.
//
// It calls GitHub's workflow_dispatch API with mode=scheduled. In that mode the
// workflow still runs its "Due?" check, so firing twice a day (to cover daylight
// saving) sends exactly one email, and the GitHub crons stay as a fallback.
//
// Setup: see "On-time emails" in README.md.

export interface TriggerEnv {
  GITHUB_TOKEN?: string; // fine-grained token, this repo only, "Actions: Read and write"
  GITHUB_REPO?: string; // owner/name
  WORKFLOW_FILE?: string; // default alerts.yml
  WORKFLOW_REF?: string; // default main
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Starts the alerts workflow. Throws with GitHub's answer when it is refused. */
export async function dispatchAlerts(env: TriggerEnv, doFetch: Fetch = fetch): Promise<void> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");
  if (!env.GITHUB_REPO || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO)) throw new Error("GITHUB_REPO must be owner/name");
  const file = env.WORKFLOW_FILE || "alerts.yml";
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(file)}/dispatches`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "job-alerts-trigger",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: env.WORKFLOW_REF || "main", inputs: { mode: "scheduled" } }),
  });
  if (res.status !== 204 && res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub refused the dispatch (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

export default {
  async scheduled(_controller: unknown, env: TriggerEnv): Promise<void> {
    await dispatchAlerts(env);
    console.log(`Started ${env.WORKFLOW_FILE || "alerts.yml"} on ${env.GITHUB_REPO}.`);
  },
  // No public page: the workers.dev URL is turned off in wrangler.trigger.jsonc.
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
