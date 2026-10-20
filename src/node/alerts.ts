// Job alerts: scan every readable company and email you the matching jobs you
// haven't been sent before.
//
//   npm run alerts                 scan and email new jobs
//   npm run alerts -- --dry-run    scan and print the email instead of sending it
//   npm run alerts -- --all        email every current match, not only new ones
//   npm run alerts -- --test-email send a short test email to check your settings
//   npm run alerts -- --no-rank    skip ranking by resume (no Workers AI calls)
//
// New jobs are ranked against your resume: embedding similarity for every job,
// plus a one-line reason and gap from Llama 3.3 for the top ALERT_TOP_N (default 8).
// The resume comes from RESUME_FILE (.pdf or .txt), else resume.pdf / resume.txt in
// the project folder, else the one you uploaded in the local app (npm run local).
//
// Only newly posted jobs are sent: ALERT_MAX_AGE_DAYS (default 3) keeps jobs posted
// in the last 3 days (a job is never sent twice). Sites that don't give a date count as new when a job first
// shows up; on the very first run those are remembered without being sent.
// ALERT_MAX_AGE_DAYS=0 turns this off.
//
// Pay: jobs whose stated range tops out below ALERT_MIN_SALARY (default 110000,
// annual USD) are dropped; jobs that don't state pay are kept. 0 turns it off.
//
// Settings live in .env (see .env.example). What was already emailed is kept in
// .data/alerts-seen.json; delete that file to start over.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findCompany, readableCompanyIds } from "../core/discover/companies.ts";
import { discoverCompany, type DiscoveredJob } from "../core/discover/discover.ts";
import { filterByLocation, filterBySalary, pickNewJobs, renderEmail, splitByAge, updateSeen, type SeenJobs } from "../core/alerts.ts";
import { rankJobs, type Ranking } from "../core/rank.ts";
import { mailConfig, sendMail } from "./mailer.ts";
import { workersAi, workersAiEmbed } from "./workers-ai.ts";

const args = new Set(process.argv.slice(2));
const DATA_DIR = new URL("../../.data/", import.meta.url);
const SEEN_FILE = new URL("alerts-seen.json", DATA_DIR);
const APP_STATE = new URL("state.json", DATA_DIR);

/** A number from a setting; empty or unset (GitHub passes unset variables as "") means the default. */
function numberSetting(value: string | undefined, fallback: number): number {
  const v = value?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function loadResume(): Promise<string | null> {
  const file = process.env.RESUME_FILE?.trim();
  if (file) {
    const path = file.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    if (!existsSync(path)) throw new Error(`RESUME_FILE not found: ${path}`);
    if (path.toLowerCase().endsWith(".pdf")) {
      const { unpdfReader } = await import("../adapters/unpdf.ts");
      const bytes = readFileSync(path);
      return (await unpdfReader.toText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).trim() || null;
    }
    return readFileSync(path, "utf8").trim() || null;
  }
  // A resume.pdf / resume.txt in the project folder (kept out of git by .gitignore).
  for (const name of ["resume.pdf", "resume.txt"]) {
    const local = fileURLToPath(new URL(`../../${name}`, import.meta.url));
    if (existsSync(local)) {
      process.env.RESUME_FILE = local;
      return loadResume();
    }
  }
  if (existsSync(APP_STATE)) {
    try {
      const resume = JSON.parse(readFileSync(APP_STATE, "utf8")).resume;
      if (typeof resume === "string" && resume.trim()) return resume;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function loadSeen(): SeenJobs | null {
  if (!existsSync(SEEN_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    return { jobs: parsed.jobs ?? {} };
  } catch {
    return null;
  }
}

function saveSeen(seen: SeenJobs) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

async function main() {
  const started = new Date();
  console.log(`[${started.toLocaleString()}] job alerts`);

  if (args.has("--test-email")) {
    const cfg = mailConfig();
    await sendMail({
      subject: "Job Tracker test email",
      text: "If you can read this, job alerts can email you.",
      html: "<p>If you can read this, job alerts can email you.</p>",
    });
    console.log(`Test email sent to ${cfg.to}.`);
    return;
  }

  const ids = readableCompanyIds();
  const matched: DiscoveredJob[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const company = findCompany(id)!;
    try {
      const r = await discoverCompany(company, fetch, { keepDescription: true });
      matched.push(...r.matched);
      const dated = r.matched.filter((j) => j.postedAt).length;
      console.log(`  ${company.name.padEnd(12)} ${r.matched.length} match (${r.listed} listed)${r.matched.length ? `, ${dated} with a posting date` : ""}`);
    } catch (err) {
      failed.push(company.name);
      console.log(`  ${company.name.padEnd(12)} failed: ${(err as Error).message}`);
    }
  }
  if (failed.length === ids.length) {
    throw new Error("Every company failed. Are you online?");
  }

  const locations = (process.env.ALERT_LOCATIONS ?? "").split(",");
  const inLocations = filterByLocation(matched, locations);
  const minSalary = numberSetting(process.env.ALERT_MIN_SALARY, 110000);
  const { kept: relevant, dropped: underpaid } = filterBySalary(inLocations, minSalary);
  if (underpaid.length) console.log(`${underpaid.length} jobs dropped: stated pay tops out under $${minSalary.toLocaleString("en-US")}.`);
  const previous = loadSeen();
  const firstRun = previous === null;
  const seen = previous ?? { jobs: {} };
  const ageSetting = (process.env.ALERT_MAX_AGE_DAYS || "3").trim().toLowerCase();
  const maxAgeDays = ageSetting === "off" ? 0 : numberSetting(ageSetting, 3);
  const { recent, old, undated } = splitByAge(relevant, maxAgeDays);
  // Undated jobs: new to us = newly posted, except on the first run, when every
  // open job is new to us. Then they're only remembered.
  const candidates = maxAgeDays > 0 && !firstRun ? [...recent, ...undated] : recent;
  const silent = maxAgeDays > 0 && firstRun ? pickNewJobs(undated, seen) : [];
  const toSend = args.has("--all") ? relevant : pickNewJobs(candidates, seen);
  const where = locations.some((l) => l.trim()) ? " in your locations" : "";
  if (maxAgeDays > 0) {
    console.log(`${relevant.length} matching jobs${where}: ${recent.length} posted in the last ${maxAgeDays} day(s), ${old.length} older, ${undated.length} with no date.`);
    if (silent.length) console.log(`First run: ${silent.length} jobs with no posting date are remembered, not sent.`);
  } else {
    console.log(`${relevant.length} matching jobs${where}.`);
  }
  console.log(`${toSend.length} to email.`);

  if (!toSend.length) {
    if (!args.has("--dry-run")) saveSeen(updateSeen(seen, silent, relevant));
    console.log("Nothing new. No email sent.");
    return;
  }

  let ranking: Ranking | null = null;
  let rankingError: string | undefined;
  if (!args.has("--no-rank") && process.env.ALERT_RANKING !== "off") {
    try {
      const resume = await loadResume();
      if (!resume) throw new Error("no resume found. Upload it in the local app (npm run local) or set RESUME_FILE in .env.");
      ranking = await rankJobs(resume, toSend, workersAiEmbed, workersAi, numberSetting(process.env.ALERT_TOP_N, 8));
      console.log(`Ranked ${toSend.length} jobs against your resume (notes for the top ${Object.keys(ranking.notes).length}).`);
    } catch (err) {
      rankingError = (err as Error).message;
      console.log(`Ranking skipped: ${rankingError}`);
    }
  }

  const email = renderEmail(toSend, { date: started, failed, firstRun, ranking, rankingError, maxAgeDays: args.has("--all") ? 0 : maxAgeDays, openMatches: relevant.length });
  if (args.has("--dry-run")) {
    console.log(`\n--- dry run: this email would be sent to ${mailConfig().to ?? "(set MAIL_TO or SMTP_USER)"} ---`);
    console.log(`Subject: ${email.subject}\n`);
    console.log(email.text);
    return;
  }

  await sendMail(email);
  saveSeen(updateSeen(seen, [...toSend, ...silent], relevant));
  console.log(`Emailed ${toSend.length} jobs to ${mailConfig().to}.`);
}

main().catch((err) => {
  console.error(`Job alerts failed: ${(err as Error).message}`);
  process.exit(1);
});
