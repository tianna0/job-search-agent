// Local development server: no Cloudflare runtime needed.
// Uses the Workers AI REST API for the model (workers-ai.ts), and a JSON file for storage.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Tracker } from "../core/tracker.ts";
import { emptyState, withDefaults, type Store, type TrackerState } from "../core/types.ts";
import { workersAi } from "./workers-ai.ts";
import { unpdfReader } from "../adapters/unpdf.ts";
import { readableCompanyIds } from "../core/discover/companies.ts";
import { dailyDue } from "../core/daily.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = new URL("../../.data/", import.meta.url);
const DATA_FILE = new URL("state.json", DATA_DIR);
const INDEX_FILE = new URL("../../public/index.html", import.meta.url);
const IMPORT_FILE = new URL("../../public/import.html", import.meta.url);
const PREFIX = "/agents/job-tracker/default/";

let cached: TrackerState | undefined;
const fileStore: Store = {
  get() {
    if (!cached) {
      cached = existsSync(DATA_FILE)
        ? (JSON.parse(readFileSync(DATA_FILE, "utf8")) as TrackerState)
        : emptyState();
    }
    return cached;
  },
  set(next) {
    cached = next;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(next, null, 2));
  },
};

// Locally, a scan runs in this process, one company after another.
// Follow-ups (no startFollowUps here) are drafted inline.
const tracker: Tracker = new Tracker({
  llm: workersAi,
  pdf: unpdfReader,
  store: fileStore,
  startScan: async (trigger) => {
    const id = `scan-${Date.now()}`;
    await tracker.scanStarted(id, trigger);
    void (async () => {
      for (const companyId of readableCompanyIds()) {
        const r = await tracker.scanCompany(id, companyId);
        console.log(`scan ${companyId}: ${r.error ? `failed (${r.error})` : `${r.matched} match, ${r.newCount} new`}`);
      }
      await tracker.scanFinished(id);
      console.log("scan finished");
    })().catch((err) => console.error("scan crashed:", err));
    return { id };
  },
});

// While this server runs: once a day after DAILY_HOUR (default 8, local time),
// scan every company and draft follow-ups. Set DAILY_HOUR=off to disable.
const DAILY_HOUR = process.env.DAILY_HOUR === "off" ? null : Number(process.env.DAILY_HOUR ?? 8);

async function dailyTick() {
  if (DAILY_HOUR === null || Number.isNaN(DAILY_HOUR)) return;
  const state = withDefaults(fileStore.get() as TrackerState);
  const now = new Date();
  const scanRunning = state.scan && !state.scan.finishedAt;
  if (!scanRunning && dailyDue(state.scan?.startedAt, now, DAILY_HOUR)) {
    console.log("daily scan starting");
    await tracker.startScan("cron").catch((err) => console.error("daily scan not started:", err.message));
  }
  if (dailyDue(state.followUps?.lastRunAt, now, DAILY_HOUR)) {
    const r = await tracker.runFollowUps();
    if (r.drafted || r.failed) console.log(`follow-ups: ${r.drafted} drafted, ${r.failed} failed`);
  }
}
setTimeout(() => void dailyTick().catch(console.error), 5000);
setInterval(() => void dailyTick().catch(console.error), 15 * 60 * 1000);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ demo: false }));
      return;
    }

    if (url.pathname.startsWith(PREFIX)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const out = await tracker.handle(
        new Request(url, {
          method,
          headers,
          body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
        })
      );
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }

    const pages: Record<string, URL> = {
      "/": INDEX_FILE,
      "/index.html": INDEX_FILE,
      "/import.html": IMPORT_FILE,
    };
    if (pages[url.pathname]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(pages[url.pathname]));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong. Please try again." }));
  }
}).listen(PORT, () => {
  console.log(`Job Tracker running at http://localhost:${PORT}`);
});
