// Cloudflare deployment (works on the Workers Free plan). The app logic lives in
// src/core; this file wires it to:
//   - an Agent (Durable Object) that owns the state and serves the API and chat,
//   - a Workflow that drafts follow-up emails, one durable step per application,
//   - a daily Cron Trigger that starts that Workflow,
//   - Workers AI for the model and PDF reading,
//   - a Cloudflare Access check in front of every API request.
// Job scanning needs more CPU than the free plan gives, so it runs in the local
// version (src/node); the deployed page says so.
//
// The same code also runs the public demo (wrangler.demo.jsonc, DEMO_MODE=1):
// every visitor gets their own Agent instance filled with sample data, the found
// jobs come from a "catalog" instance you push a local scan into, and each
// visitor has a daily cap on AI calls.
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Tracker } from "../core/tracker.ts";
import { llmText } from "../core/util.ts";
import { emptyState, MODEL, type Application, type CatalogSnapshot, type LLM, type PdfReader, type TrackerState } from "../core/types.ts";
import { runFollowUpSteps, type FollowUpAgentApi, type StepRunner } from "../core/followup-workflow.ts";
import { unpdfReader } from "../adapters/unpdf.ts";
import { checkAccess } from "./access.ts";
import { checkPushToken, isDemo, isValidVisitorId, CATALOG } from "./demo-gate.ts";

interface Env {
  AI: Ai;
  JobTracker: DurableObjectNamespace<JobTracker>;
  FOLLOWUPS: Workflow<FollowUpParams>;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEMO_MODE?: string;
  DEMO_PUSH_TOKEN?: string;
}

interface FollowUpParams {
  agent?: string;
}

const DEFAULT_AGENT = "default"; // the private app's single instance
const DEMO_AI_CALLS_PER_DAY = 25;

function workersAiLlm(env: Env): LLM {
  return {
    async complete(system, user) {
      const out = (await env.AI.run(MODEL as any, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 1200,
      } as any)) as { response?: unknown };
      return llmText(out.response);
    },
  };
}

/** Workers AI's document conversion (little CPU for this Worker), with pdf.js as a fallback. */
function workersAiPdf(env: Env): PdfReader {
  return {
    async toText(bytes) {
      try {
        const result: any = await (env.AI as any).toMarkdown([
          { name: "resume.pdf", blob: new Blob([bytes], { type: "application/pdf" }) },
        ]);
        const first = Array.isArray(result) ? result[0] : result;
        if (first && first.format !== "error" && typeof first.data === "string" && first.data.trim()) {
          return first.data;
        }
      } catch (err) {
        console.warn("toMarkdown failed, falling back to pdf.js:", err);
      }
      return unpdfReader.toText(bytes);
    },
  };
}

/** /agents/job-tracker/<instance>/<route> -> <instance> */
function instanceFromPath(pathname: string): string {
  return pathname.split("/")[3] ?? DEFAULT_AGENT;
}

export class JobTracker extends Agent<Env, TrackerState> implements FollowUpAgentApi {
  initialState: TrackerState = emptyState();

  private tracker(instance = DEFAULT_AGENT): Tracker {
    const env = this.env;
    const demo = isDemo(env);
    return new Tracker({
      llm: workersAiLlm(env),
      pdf: workersAiPdf(env),
      store: {
        get: () => this.state,
        set: (next) => this.setState(next),
      },
      // No startScan: scanning runs locally (see the note at the top).
      startFollowUps: async () => {
        const instanceRun = await env.FOLLOWUPS.create({ id: `followups-${instance}-${Date.now()}`, params: { agent: instance } });
        return { id: instanceRun.id };
      },
      ...(demo
        ? {
            aiDailyLimit: DEMO_AI_CALLS_PER_DAY,
            demoSnapshot: async () => {
              const catalog = (await getAgentByName(env.JobTracker, CATALOG)) as unknown as { catalogSnapshot(): Promise<CatalogSnapshot> };
              return catalog.catalogSnapshot();
            },
          }
        : {}),
    });
  }

  async onRequest(request: Request): Promise<Response> {
    return this.tracker(instanceFromPath(new URL(request.url).pathname)).handle(request);
  }

  // Called by FollowUpWorkflow over RPC. Follow-ups don't touch the demo seed or AI cap
  // beyond the model calls themselves, so the default instance name is fine here.
  async staleApplicationIds(): Promise<string[]> {
    return this.tracker().staleApplicationIds();
  }

  async draftFollowUp(id: string): Promise<Application> {
    return this.tracker().draftFollowUp(id);
  }

  async followUpsDone(drafted: number): Promise<void> {
    await this.tracker().followUpsDone(drafted);
  }

  // Demo catalog instance only (called from the Worker and from visitor instances).
  async catalogSnapshot(): Promise<CatalogSnapshot> {
    return new Tracker({ llm: workersAiLlm(this.env), pdf: workersAiPdf(this.env), store: { get: () => this.state, set: (n) => this.setState(n) } }).catalogSnapshot();
  }

  async replaceCatalog(body: unknown): Promise<{ jobs: number }> {
    return new Tracker({ llm: workersAiLlm(this.env), pdf: workersAiPdf(this.env), store: { get: () => this.state, set: (n) => this.setState(n) } }).replaceCatalog(body);
  }
}

export class FollowUpWorkflow extends WorkflowEntrypoint<Env, FollowUpParams> {
  async run(event: WorkflowEvent<FollowUpParams>, step: WorkflowStep) {
    const env = this.env;
    const name = event.payload?.agent || DEFAULT_AGENT;
    return runFollowUpSteps(
      step as unknown as StepRunner,
      async () => (await getAgentByName(env.JobTracker, name)) as unknown as FollowUpAgentApi
    );
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const demo = isDemo(env);

    // The page talks to the Agent over plain HTTP. Agent WebSockets would push the
    // whole state (resume included) to anyone who connects, so they are turned off.
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      return new Response("WebSocket connections are disabled.", { status: 403 });
    }

    // Tells the page which mode it's in (no data, so no login needed).
    if (url.pathname === "/api/config") return json({ demo });

    if (demo) {
      // Push a local scan into the shared catalog: npm run push-demo
      if (url.pathname === "/api/push-jobs" && request.method === "POST") {
        const denied = checkPushToken(request, env.DEMO_PUSH_TOKEN);
        if (denied) return denied;
        const catalog = (await getAgentByName(env.JobTracker, CATALOG)) as unknown as { replaceCatalog(b: unknown): Promise<{ jobs: number }> };
        return json(await catalog.replaceCatalog(await request.json().catch(() => ({}))));
      }
      // Visitors only reach their own instance; the catalog and the private name are off limits.
      if (url.pathname.startsWith("/agents/")) {
        const instance = instanceFromPath(url.pathname);
        if (!isValidVisitorId(instance)) return json({ error: "Not found" }, 404);
      }
    }

    const denied = await checkAccess(request, env);
    if (denied) return denied;
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  },

  // Daily follow-up check for the private app (the demo config has no cron).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const id = `followups-${new Date(controller.scheduledTime).toISOString().slice(0, 10)}`;
    ctx.waitUntil(
      env.FOLLOWUPS.create({ id, params: { agent: DEFAULT_AGENT } }).then(
        () => console.log(`started ${id}`),
        (err) => console.error(`follow-up run ${id} not started:`, err)
      )
    );
  },
} satisfies ExportedHandler<Env>;
