// Chat with tools. The model answers with one JSON object per step:
//   {"tool": "<name>", "args": {...}}   to call a tool, or
//   {"reply": "<text for the user>"}    when it's done.
// A plain JSON protocol (instead of a provider's function-calling format) behaves
// the same through the Workers AI binding and its REST API, and is easy to test.
import { FOLLOW_UP_AFTER_DAYS, STATUSES, type Application, type ChatMessage, type LLM, type TrackerState } from "./types.ts";

export interface ChatTools {
  getState(): Promise<TrackerState>;
  trackDiscovered(jobId: string): Promise<Application>;
  setStatus(applicationId: string, status: string): Promise<unknown>;
  reviseCoverLetter(applicationId: string, instructions: string): Promise<Application>;
  startScan(): Promise<{ id: string }>;
  draftFollowUps(): Promise<unknown>;
}

const MAX_STEPS = 5;
const RESULT_CHARS = 2500;
const HISTORY_FOR_PROMPT = 10;
const NEW_DAYS = 7;

const SYSTEM = `You are the assistant inside the user's personal job-search app. It tracks software-engineering job applications, finds entry-level jobs at about 40 companies, and drafts cover letters.

To call a tool, reply with ONLY a JSON object: {"tool": "<name>", "args": {...}}
When you have the answer, reply with ONLY: {"reply": "<message for the user>"}

Tools:
- list_jobs(level?: "entry"|"maybe", company?: string, category?: "SWE"|"SDE"|"Backend"|"Frontend"|"Full-stack"|"QA/SDET", query?: string, new_only?: boolean, limit?: number)
  Jobs found by scans that are not in the tracker yet. new_only = first seen in the last ${NEW_DAYS} days.
- list_applications(status?: ${STATUSES.map((s) => `"${s}"`).join("|")})
  Jobs in the tracker, with fit scores.
- add_job(job_id: string)
  Analyzes a found job against the resume and adds it to the tracker. Takes about 20 seconds.
- update_status(application_id: string, status: string)
- get_cover_letter(application_id: string)
- revise_cover_letter(application_id: string, instructions: string)
- get_follow_up(application_id: string)
  The drafted follow-up email for an application, if there is one.
- draft_follow_ups()
  Drafts follow-up emails for applications that have been in "applied" for ${FOLLOW_UP_AFTER_DAYS}+ days with no news.
- start_scan()
  Scans all companies for new jobs in the background. Takes several minutes. Only works in the local version.
- scan_status()

Rules:
- Use only ids that tools returned. Never invent jobs, companies, ids, or numbers.
- Only change data (add_job, update_status, revise_cover_letter, start_scan) when the user asked for it.
- Keep replies short. For several jobs use a list with company, title, location and level.
- Reply in the same language the user writes in.`;

function clip(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > RESULT_CHARS ? s.slice(0, RESULT_CHARS) + "…(truncated)" : s;
}

function parseStep(raw: string): { tool?: string; args?: Record<string, unknown>; reply?: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (obj && typeof obj === "object") {
        if (typeof obj.tool === "string") {
          return { tool: obj.tool, args: obj.args && typeof obj.args === "object" ? obj.args : {} };
        }
        if ("reply" in obj) return { reply: String(obj.reply ?? "") };
      }
    } catch {
      /* fall through: treat as plain text */
    }
  }
  return { reply: raw.trim() };
}

const lower = (v: unknown) => String(v ?? "").toLowerCase();

async function runTool(name: string, args: Record<string, unknown>, tools: ChatTools): Promise<unknown> {
  switch (name) {
    case "list_jobs": {
      const state = await tools.getState();
      const tracked = new Set(state.applications.map((a) => a.url));
      const cutoff = Date.now() - NEW_DAYS * 24 * 60 * 60 * 1000;
      const company = lower(args.company);
      const query = lower(args.query);
      const matches = state.discovered.filter(
        (j) =>
          !tracked.has(j.url) &&
          (!args.level || j.level === args.level) &&
          (!args.category || lower(j.category) === lower(args.category)) &&
          (!company || j.company === company || lower(j.companyName).includes(company)) &&
          (!query || lower(`${j.title} ${j.location}`).includes(query)) &&
          (!args.new_only || Date.parse(j.firstSeen) >= cutoff)
      );
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      return {
        total: matches.length,
        jobs: matches.slice(0, limit).map((j) => ({
          job_id: j.id,
          company: j.companyName,
          title: j.title,
          location: j.location,
          level: j.level,
          category: j.category,
        })),
      };
    }
    case "list_applications": {
      const state = await tools.getState();
      return state.applications
        .filter((a) => !args.status || a.status === args.status)
        .map((a) => ({
          application_id: a.id,
          company: a.company,
          title: a.title,
          status: a.status,
          fit_score: a.fitScore,
          days_since_update: Math.floor((Date.now() - Date.parse(a.updatedAt)) / 86_400_000),
          has_follow_up_draft: Boolean(a.followUp),
        }));
    }
    case "add_job": {
      const app = await tools.trackDiscovered(String(args.job_id ?? ""));
      return { application_id: app.id, company: app.company, title: app.title, fit_score: app.fitScore, strengths: app.strengths, gaps: app.gaps };
    }
    case "update_status": {
      await tools.setStatus(String(args.application_id ?? ""), String(args.status ?? ""));
      return { ok: true };
    }
    case "get_cover_letter": {
      const state = await tools.getState();
      const app = state.applications.find((a) => a.id === args.application_id);
      if (!app) return { error: "Application not found. Call list_applications to get ids." };
      return { company: app.company, title: app.title, cover_letter: app.coverLetter };
    }
    case "revise_cover_letter": {
      const app = await tools.reviseCoverLetter(String(args.application_id ?? ""), String(args.instructions ?? ""));
      return { application_id: app.id, cover_letter: app.coverLetter };
    }
    case "get_follow_up": {
      const state = await tools.getState();
      const app = state.applications.find((a) => a.id === args.application_id);
      if (!app) return { error: "Application not found. Call list_applications to get ids." };
      return app.followUp
        ? { company: app.company, title: app.title, drafted_at: app.followUp.draftedAt, email: app.followUp.text }
        : { company: app.company, title: app.title, email: null, note: "No follow-up drafted yet." };
    }
    case "draft_follow_ups":
      return tools.draftFollowUps();
    case "start_scan": {
      const { id } = await tools.startScan();
      return { scan_id: id, note: "Runs in the background and takes several minutes." };
    }
    case "scan_status": {
      const s = (await tools.getState()).scan;
      if (!s) return { scan: null };
      return {
        started_at: s.startedAt,
        finished_at: s.finishedAt ?? null,
        progress: `${s.done.length}/${s.companies.length} companies`,
        matched: s.matched,
        new_jobs: s.newJobs,
        failed: s.failed.map((f) => f.company),
      };
    }
    default:
      return { error: `Unknown tool "${name}".` };
  }
}

/** Runs one user turn and returns the assistant's reply. */
export async function runChat(llm: LLM, tools: ChatTools, history: ChatMessage[], message: string): Promise<string> {
  const convo = [...history.slice(-HISTORY_FOR_PROMPT), { role: "user" as const, text: message }]
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  const results: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const prompt =
      `Today is ${new Date().toISOString().slice(0, 10)}.\n\nCONVERSATION (most recent last):\n${convo}\n\n` +
      (results.length ? `TOOL RESULTS FOR THIS MESSAGE:\n${results.join("\n")}\n\n` : "") +
      "Respond with one JSON object.";
    const raw = await llm.complete(SYSTEM, prompt);
    const parsed = parseStep(raw);
    if (parsed.tool === undefined) return parsed.reply || "Sorry, I didn't get an answer. Please try again.";

    let result: unknown;
    try {
      result = await runTool(parsed.tool, parsed.args ?? {}, tools);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    results.push(`${results.length + 1}. ${parsed.tool}(${JSON.stringify(parsed.args ?? {})}) -> ${clip(result)}`);
  }
  return "Sorry, I couldn't finish that in a few steps. Could you ask more specifically?";
}
