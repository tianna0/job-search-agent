import {
  FOLLOW_UP_AFTER_DAYS,
  STATUSES,
  withDefaults,
  type Application,
  type CatalogSnapshot,
  type ChatMessage,
  type LLM,
  type Deps,
  type ScanState,
  type TrackerState,
} from "./types.ts";
import { fetchJobPage, MAX_TEXT_CHARS } from "./jobpage.ts";
import { HttpError, extractJson, json } from "./util.ts";
import { COMPANIES, findCompany, readableCompanyIds } from "./discover/companies.ts";
import { discoverCompany, fetchDiscoveredJob, mergeDiscovered, type DiscoveredJob } from "./discover/discover.ts";
import { runChat, type ChatTools } from "./chat.ts";
import { demoState, sanitizeCatalog } from "./demo.ts";

const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** A scan with no progress for this long is treated as dead, so a new one can start. */
const SCAN_STALE_MS = 2 * 60 * 60 * 1000;
const CHAT_HISTORY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The whole app, with no dependency on Cloudflare or Node.
 * Feed it a standard Request, get a standard Response.
 */
export class Tracker {
  private deps: Deps;
  /** The model, behind the demo's daily cap when one is set. */
  private llm: LLM;

  constructor(deps: Deps) {
    this.deps = deps;
    const limit = deps.aiDailyLimit;
    this.llm = limit
      ? { complete: async (system, user) => { await this.countAiCall(limit); return deps.llm.complete(system, user); } }
      : deps.llm;
  }

  private async countAiCall(limit: number): Promise<void> {
    const state = await this.getState();
    const day = new Date().toISOString().slice(0, 10);
    const used = state.aiUsage?.day === day ? state.aiUsage.calls : 0;
    if (used >= limit) {
      throw new HttpError(
        429,
        `This demo allows ${limit} AI calls per visitor per day and they're used up. Try again tomorrow, or run the app locally.`
      );
    }
    await this.deps.store.set({ ...state, aiUsage: { day, calls: used + 1 } });
  }

  // ---------- Public demo ----------

  /** Fills this visitor's copy with the sample resume, the shared jobs and a sample application. */
  async seedDemo(): Promise<TrackerState> {
    if (!this.deps.demoSnapshot) throw new HttpError(404, "Not found");
    const next = demoState(await this.deps.demoSnapshot());
    await this.deps.store.set(next);
    return next;
  }

  /** The shared job list demo visitors start from. */
  async catalogSnapshot(): Promise<CatalogSnapshot> {
    const s = await this.getState();
    return { discovered: s.discovered, lastDiscovery: s.lastDiscovery };
  }

  /** Replaces the shared job list with a pushed snapshot (validated). */
  async replaceCatalog(input: unknown): Promise<{ jobs: number }> {
    const snap = sanitizeCatalog(input);
    const s = await this.getState();
    await this.deps.store.set({ ...s, discovered: snap.discovered, lastDiscovery: snap.lastDiscovery });
    return { jobs: snap.discovered.length };
  }

  private async getState(): Promise<TrackerState> {
    return withDefaults(await this.deps.store.get());
  }

  private get doFetch(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  /** Read the job posting, identify the role, and score the resume against it. */
  private async analyzeJob(resume: string, jobText: string) {
    const reply = await this.llm.complete(
      "You are a candid career coach. The user message contains a resume and the text of a " +
        "job posting web page. Identify the role, then compare the resume to it. " +
        'Reply with ONLY a JSON object: {"company": string, "title": string, ' +
        '"fitScore": number 0-100, "strengths": string[] (max 4), "gaps": string[] (max 4)}. ' +
        'Use "Unknown" if the company or title is not stated.',
      `RESUME:\n${resume}\n\nJOB POSTING PAGE:\n${jobText}`
    );
    const p = extractJson(reply);
    return {
      company: String(p.company || "Unknown").slice(0, 120),
      title: String(p.title || "Unknown").slice(0, 160),
      fitScore: Math.max(0, Math.min(100, Math.round(Number(p.fitScore) || 0))),
      strengths: Array.isArray(p.strengths) ? p.strengths.map(String) : [],
      gaps: Array.isArray(p.gaps) ? p.gaps.map(String) : [],
    };
  }

  private draftCoverLetter(
    resume: string,
    company: string,
    title: string,
    jobText: string
  ) {
    return this.llm.complete(
      "You write concise, specific cover letters (under 250 words). " +
        "Use only facts present in the resume. No placeholders, no flattery.",
      `Company: ${company}\nRole: ${title}\n\nRESUME:\n${resume}\n\nJOB POSTING PAGE:\n${jobText}`
    );
  }

  private async uploadResume(request: Request): Promise<TrackerState> {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) throw new HttpError(400, "The file is empty.");
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new HttpError(413, "The PDF is larger than 5 MB.");
    }
    const magic = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 4)));
    if (magic !== "%PDF") throw new HttpError(400, "Please upload a PDF file.");

    let name = "resume.pdf";
    try {
      name = decodeURIComponent(request.headers.get("x-filename") ?? name);
    } catch {
      /* keep default */
    }

    let text: string;
    try {
      text = (await this.deps.pdf.toText(bytes)).trim();
    } catch {
      throw new HttpError(422, "Couldn't read that PDF.");
    }
    if (text.length < 100) {
      throw new HttpError(
        422,
        "Couldn't extract text from that PDF. Scanned or image-only PDFs aren't supported yet."
      );
    }
    const state = await this.getState();
    const next = { ...state, resumeName: name, resume: text.slice(0, MAX_TEXT_CHARS) };
    await this.deps.store.set(next);
    return next;
  }

  /** Analyze a job's text against the resume and save it as an application. */
  private async saveApplication(url: string, jobText: string): Promise<Application> {
    const state = await this.getState();
    if (!state.resume) throw new HttpError(400, "Upload your resume first.");
    if (state.applications.some((a) => a.url === url)) {
      throw new HttpError(409, "That job is already in your tracker.");
    }

    const fit = await this.analyzeJob(state.resume, jobText);
    const coverLetter = await this.draftCoverLetter(
      state.resume,
      fit.company,
      fit.title,
      jobText
    );
    const now = new Date().toISOString();
    const app: Application = {
      id: crypto.randomUUID(),
      url,
      status: "saved",
      ...fit,
      coverLetter,
      createdAt: now,
      updatedAt: now,
    };
    // Re-read in case state changed while the model was thinking.
    const latest = await this.getState();
    await this.deps.store.set({
      ...latest,
      applications: [app, ...latest.applications],
    });
    return app;
  }

  private async addJob(url: string): Promise<Application> {
    const state = await this.getState();
    if (!state.resume) throw new HttpError(400, "Upload your resume first.");
    const job = await fetchJobPage(url, this.deps.fetch);
    return this.saveApplication(job.url, job.text);
  }

  /** Screen one company's job board. */
  private async discover(companyId: unknown) {
    const company = findCompany(String(companyId ?? ""));
    if (!company) throw new HttpError(404, "Unknown company.");
    if (!company.source) {
      throw new HttpError(422, `${company.name}: ${company.note ?? "can't be read automatically."}`);
    }
    let result;
    try {
      result = await discoverCompany(company, this.doFetch, this.deps.discover);
    } catch (err) {
      console.error(`discover ${company.id} failed:`, err);
      throw new HttpError(
        502,
        `Couldn't read ${company.name}'s jobs (${(err as Error).message}). The site may have changed; run npm run check-companies.`
      );
    }
    const newIds = await this.saveDiscovered(company.id, result.matched);
    return {
      company: company.id,
      listed: result.listed,
      matched: result.matched.length,
      newCount: newIds.length,
      skipped: result.skipped,
      notChecked: result.notChecked,
    };
  }

  /** Replace one company's results; returns the ids of jobs not seen before. */
  private async saveDiscovered(companyId: string, matched: DiscoveredJob[]): Promise<string[]> {
    const state = await this.getState();
    const { jobs, newIds } = mergeDiscovered(state.discovered, companyId, matched);
    await this.deps.store.set({
      ...state,
      discovered: jobs,
      lastDiscovery: { ...state.lastDiscovery, [companyId]: new Date().toISOString() },
    });
    return newIds;
  }

  // ---------- Scans across all companies ----------
  // On Cloudflare a Workflow calls these through the Agent (one durable step per
  // company). Locally the Node server calls them in-process.

  /** Starts a background scan through the platform (Workflow or local runner). */
  async startScan(trigger: ScanState["trigger"]): Promise<{ id: string }> {
    if (!this.deps.startScan) {
      throw new HttpError(
        501,
        "Scanning runs in the local version of the app (npm run local). It needs more CPU than Cloudflare's free plan allows."
      );
    }
    const s = (await this.getState()).scan;
    if (s && !s.finishedAt && Date.now() - Date.parse(s.startedAt) < SCAN_STALE_MS) {
      throw new HttpError(409, "A scan is already running.");
    }
    return this.deps.startScan(trigger);
  }

  /** Records the start of a scan. Calling it again with the same id does nothing. */
  async scanStarted(id: string, trigger: ScanState["trigger"], companies = readableCompanyIds()): Promise<void> {
    const state = await this.getState();
    if (state.scan?.id === id) return;
    await this.deps.store.set({
      ...state,
      scan: { id, trigger, startedAt: new Date().toISOString(), companies, done: [], failed: [], matched: 0, newJobs: 0 },
    });
  }

  /** Saves one company's result (or failure) and updates the scan's progress. Safe to repeat. */
  async recordScanResult(
    id: string,
    companyId: string,
    outcome: { ok: true; matched: DiscoveredJob[] } | { ok: false; error: string }
  ): Promise<{ matched?: number; newCount?: number; error?: string }> {
    let summary: { matched?: number; newCount?: number; error?: string };
    if (outcome.ok) {
      const newIds = await this.saveDiscovered(companyId, outcome.matched);
      summary = { matched: outcome.matched.length, newCount: newIds.length };
    } else {
      summary = { error: outcome.error };
    }
    const state = await this.getState();
    const scan = state.scan;
    if (scan && scan.id === id && !scan.done.includes(companyId)) {
      await this.deps.store.set({
        ...state,
        scan: {
          ...scan,
          done: [...scan.done, companyId],
          failed: outcome.ok ? scan.failed : [...scan.failed, { company: companyId, error: outcome.error }],
          matched: scan.matched + (summary.matched ?? 0),
          newJobs: scan.newJobs + (summary.newCount ?? 0),
        },
      });
    }
    return summary;
  }

  async scanFinished(id: string): Promise<void> {
    const state = await this.getState();
    if (state.scan?.id !== id || state.scan.finishedAt) return;
    await this.deps.store.set({ ...state, scan: { ...state.scan, finishedAt: new Date().toISOString() } });
  }

  /** Scans one company as part of a scan. Never throws; failures are recorded. */
  async scanCompany(id: string, companyId: string): Promise<{ matched?: number; newCount?: number; error?: string }> {
    const company = findCompany(companyId);
    if (!company?.source) return this.recordScanResult(id, companyId, { ok: false, error: "Not readable automatically." });
    try {
      const r = await discoverCompany(company, this.doFetch, this.deps.discover);
      return this.recordScanResult(id, companyId, { ok: true, matched: r.matched });
    } catch (err) {
      return this.recordScanResult(id, companyId, { ok: false, error: (err as Error).message });
    }
  }

  // ---------- Chat ----------

  private async chat(message: unknown): Promise<{ reply: string; chat: ChatMessage[] }> {
    const text = String(message ?? "").trim().slice(0, 2000);
    if (!text) throw new HttpError(400, "Type a message first.");
    const before = await this.getState();
    const reply = await runChat(this.llm, this.chatTools(), before.chat, text);
    const now = new Date().toISOString();
    const after = await this.getState(); // tools may have changed state
    const chat = [...after.chat, { role: "user" as const, text, at: now }, { role: "assistant" as const, text: reply, at: now }].slice(-CHAT_HISTORY);
    await this.deps.store.set({ ...after, chat });
    return { reply, chat };
  }

  private chatTools(): ChatTools {
    return {
      getState: () => this.getState(),
      trackDiscovered: (id) => this.trackDiscovered(id),
      setStatus: (id, status) => this.setStatus(id, status),
      reviseCoverLetter: (id, instructions) => this.reviseCoverLetter(id, instructions),
      startScan: () => this.startScan("chat"),
      draftFollowUps: () => this.startFollowUps(),
    };
  }

  /** Rewrites an application's cover letter following the user's instructions. */
  private async reviseCoverLetter(id: string, instructions: string): Promise<Application> {
    const state = await this.getState();
    const app = state.applications.find((a) => a.id === id);
    if (!app) throw new HttpError(404, "Application not found.");
    const letter = (await this.llm.complete(
      "You revise cover letters. Keep it under 250 words, use only facts from the resume, no placeholders. " +
        "Reply with the revised letter only.",
      `Company: ${app.company}\nRole: ${app.title}\n\nRESUME:\n${state.resume}\n\nCURRENT LETTER:\n${app.coverLetter}\n\nREQUESTED CHANGES:\n${instructions}`
    )).trim();
    if (!letter) throw new HttpError(502, "The model returned an empty letter. Try again.");
    const latest = await this.getState();
    const updated = { ...app, coverLetter: letter, updatedAt: new Date().toISOString() };
    await this.deps.store.set({
      ...latest,
      applications: latest.applications.map((a) => (a.id === id ? updated : a)),
    });
    return updated;
  }

  // ---------- Follow-ups ----------
  // Applications sitting in "applied" with no change for FOLLOW_UP_AFTER_DAYS get
  // a short follow-up email drafted. On Cloudflare a daily Workflow calls these
  // through the Agent; locally they run inline.

  /** Ids of applications that need a follow-up draft now. */
  async staleApplicationIds(now = Date.now()): Promise<string[]> {
    const limit = FOLLOW_UP_AFTER_DAYS * DAY_MS;
    return (await this.getState()).applications
      .filter(
        (a) =>
          a.status === "applied" &&
          now - Date.parse(a.updatedAt) >= limit &&
          (!a.followUp || now - Date.parse(a.followUp.draftedAt) >= limit)
      )
      .map((a) => a.id);
  }

  /** Drafts and saves a follow-up email for one application. */
  async draftFollowUp(id: string): Promise<Application> {
    const state = await this.getState();
    const app = state.applications.find((a) => a.id === id);
    if (!app) throw new HttpError(404, "Application not found.");
    const days = Math.floor((Date.now() - Date.parse(app.updatedAt)) / DAY_MS);
    const text = (await this.llm.complete(
      "You write short, polite follow-up emails from a job applicant to a recruiter. Under 120 words. " +
        "Restate interest in the role, add one concrete strength from the resume, ask about next steps. " +
        "No placeholders like [Name]: open with 'Hi,' and sign off without a name. Reply with the email text only.",
      `Company: ${app.company}\nRole: ${app.title}\nApplied about ${days} days ago with no reply.\n\nRESUME:\n${state.resume}`
    )).trim();
    if (!text) throw new HttpError(502, "The model returned an empty draft. Try again.");
    const latest = await this.getState();
    const updated = { ...app, followUp: { text, draftedAt: new Date().toISOString() } };
    await this.deps.store.set({
      ...latest,
      applications: latest.applications.map((a) => (a.id === id ? updated : a)),
    });
    return updated;
  }

  async followUpsDone(drafted: number): Promise<void> {
    const state = await this.getState();
    await this.deps.store.set({ ...state, followUps: { lastRunAt: new Date().toISOString(), drafted } });
  }

  /** Drafts every due follow-up, one after another. One failure doesn't stop the rest. */
  async runFollowUps(): Promise<{ drafted: number; failed: number }> {
    let drafted = 0;
    let failed = 0;
    for (const id of await this.staleApplicationIds()) {
      try {
        await this.draftFollowUp(id);
        drafted++;
      } catch (err) {
        failed++;
        console.error(`follow-up for ${id} failed:`, err);
      }
    }
    await this.followUpsDone(drafted);
    return { drafted, failed };
  }

  /** In the background where the platform supports it (Cloudflare Workflow), otherwise inline. */
  private async startFollowUps(): Promise<{ started: string } | { drafted: number; failed: number }> {
    if (this.deps.startFollowUps) return { started: (await this.deps.startFollowUps()).id };
    return this.runFollowUps();
  }

  /** Analyze a discovered job and move it into the tracker. */
  private async trackDiscovered(id: unknown): Promise<Application> {
    const state = await this.getState();
    const found = state.discovered.find((j) => j.id === id);
    if (!found) throw new HttpError(404, "Job not found. Run discovery again.");
    const company = findCompany(found.company);
    if (!company) throw new HttpError(404, "Unknown company.");
    if (!state.resume) throw new HttpError(400, "Upload your resume first.");

    let raw;
    try {
      raw = await fetchDiscoveredJob(company, found, this.doFetch);
    } catch (err) {
      throw new HttpError(502, `Couldn't re-read ${company.name}'s posting (${(err as Error).message}).`);
    }
    if (!raw) throw new HttpError(410, "That posting is no longer listed.");

    const text =
      `Company: ${company.name}\nTitle: ${raw.title ?? found.title}\nLocation: ${raw.location ?? found.location}\n\n` +
      raw.description.slice(0, MAX_TEXT_CHARS);
    return this.saveApplication(found.url, text);
  }

  /** A job page sent from the bookmarklet: the text was read in the user's own browser. */
  private async importPage(body: Record<string, any>): Promise<Application> {
    let url: URL;
    try {
      url = new URL(String(body.url ?? ""));
    } catch {
      throw new HttpError(400, "The page address is missing or invalid.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new HttpError(400, "Only http(s) pages can be imported.");
    }
    const title = String(body.title ?? "").slice(0, 300);
    const text = String(body.text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    if (text.length < 200) {
      throw new HttpError(422, "That page has too little text to be a job posting. Open the job's own page and try again.");
    }
    return this.saveApplication(url.toString(), `Page title: ${title}\n${text}`.slice(0, MAX_TEXT_CHARS));
  }

  private async setStatus(id: unknown, status: unknown): Promise<TrackerState> {
    if (!STATUSES.includes(status as any)) {
      throw new HttpError(400, "Invalid status.");
    }
    const state = await this.getState();
    if (!state.applications.some((a) => a.id === id)) {
      throw new HttpError(404, "Application not found.");
    }
    const next: TrackerState = {
      ...state,
      applications: state.applications.map((a) =>
        a.id === id
          ? { ...a, status: status as Application["status"], updatedAt: new Date().toISOString() }
          : a
      ),
    };
    await this.deps.store.set(next);
    return next;
  }

  /** Routes are the last path segment: state, companies, resume, apply, discover, track, status. */
  async handle(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname.split("/").pop();
    try {
      // Public demo: a visitor's first request fills their copy with sample data.
      if (this.deps.demoSnapshot && !(await this.getState()).demoSeededAt) await this.seedDemo();

      if (request.method === "GET") {
        if (route === "state") return json(await this.getState());
        if (route === "info") {
          return json({
            canScan: Boolean(this.deps.startScan),
            followUpAfterDays: FOLLOW_UP_AFTER_DAYS,
            demo: Boolean(this.deps.demoSnapshot),
            aiDailyLimit: this.deps.aiDailyLimit ?? null,
          });
        }
        if (route === "companies") {
          return json(COMPANIES.map((c) => ({ id: c.id, name: c.name, group: c.group, starred: c.starred, readable: c.source !== null, note: c.note ?? "" })));
        }
        return json({ error: "Not found" }, 404);
      }
      if (request.method !== "POST") return json({ error: "Not found" }, 404);

      if (route === "resume") return json(await this.uploadResume(request));

      let body: Record<string, any>;
      try {
        body = (await request.json()) as Record<string, any>;
      } catch {
        throw new HttpError(400, "Invalid request.");
      }
      if (route === "apply") return json(await this.addJob(String(body.url ?? "")));
      if (route === "discover") return json(await this.discover(body.company));
      if (route === "track") return json(await this.trackDiscovered(body.id));
      if (route === "import") return json(await this.importPage(body));
      if (route === "status") return json(await this.setStatus(body.id, body.status));
      if (route === "scan") return json(await this.startScan("manual"));
      if (route === "follow-ups") return json(await this.startFollowUps());
      if (route === "demo-reset") return json(await this.seedDemo());
      if (route === "chat") return json(await this.chat(body.message));
      if (route === "chat-reset") {
        const state = await this.getState();
        await this.deps.store.set({ ...state, chat: [] });
        return json({ chat: [] });
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  }
}
