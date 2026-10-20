// Job alerts: decide which found jobs are new, remember what was emailed, and
// build the email. No I/O here, so it's easy to test.
import type { DiscoveredJob } from "./discover/discover.ts";

/** job id -> ISO time it was first emailed */
export interface SeenJobs {
  jobs: Record<string, string>;
}

const FORGET_AFTER_DAYS = 90;
const MAX_LISTED = 200;

/** Jobs not emailed before. */
export function pickNewJobs(matched: DiscoveredJob[], seen: SeenJobs): DiscoveredJob[] {
  return matched.filter((j) => !(j.id in seen.jobs));
}

/** Remembers newly emailed jobs and forgets very old ones that are no longer listed. */
export function updateSeen(seen: SeenJobs, emailed: DiscoveredJob[], stillListed: DiscoveredJob[], now = Date.now()): SeenJobs {
  const listed = new Set(stillListed.map((j) => j.id));
  const cutoff = now - FORGET_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const jobs: Record<string, string> = {};
  for (const [id, at] of Object.entries(seen.jobs)) {
    if (listed.has(id) || Date.parse(at) >= cutoff) jobs[id] = at;
  }
  const stamp = new Date(now).toISOString();
  for (const j of emailed) jobs[j.id] ??= stamp;
  return { jobs };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Sorts jobs by how recently they were posted.
 *   recent:  posted within maxAgeDays, plus one day of slack because some sites
 *            only give a date (no time) and runs don't happen at the same minute.
 *            Jobs already emailed are filtered out separately, so the slack never
 *            causes repeats.
 *   old:     posted before that.
 *   undated: the site doesn't say when it was posted.
 * maxAgeDays <= 0 turns the filter off (everything counts as recent).
 */
export function splitByAge(jobs: DiscoveredJob[], maxAgeDays: number, now = Date.now()) {
  const recent: DiscoveredJob[] = [], old: DiscoveredJob[] = [], undated: DiscoveredJob[] = [];
  const cutoff = now - (maxAgeDays + 1) * DAY;
  for (const j of jobs) {
    const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
    if (maxAgeDays <= 0) recent.push(j);
    else if (Number.isNaN(t)) undated.push(j);
    else if (t >= cutoff) recent.push(j);
    else old.push(j);
  }
  return { recent, old, undated };
}

/** "Posted Oct 17", or a note that the site doesn't give a date. */
export function postedLabel(j: DiscoveredJob, timeZone?: string): string {
  if (!j.postedAt) return "Posted date not given";
  const d = new Date(j.postedAt);
  if (Number.isNaN(d.getTime())) return "Posted date not given";
  return `Posted ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) })}`;
}

const US_STATES =
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const US_KEYS = new Set(["us", "usa", "u.s.", "united states", "united states of america"]);
/** "Seattle, WA" / "Austin, TX, Remote": a US state code after a comma. */
const US_STATE_RE = new RegExp(`,\\s*(${US_STATES.join("|")})\\b`);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keep jobs whose location mentions one of the keywords as a whole word
 * ("US" matches "Remote - US" but not "Aarhus"). A US keyword also matches
 * "City, ST" with a US state code. Jobs with no location are kept.
 */
export function filterByLocation(jobs: DiscoveredJob[], keywords: string[]): DiscoveredJob[] {
  const keys = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return jobs;
  const res = keys.map((k) => new RegExp(`(^|[^a-z0-9])${escRe(k)}(?![a-z0-9])`, "i"));
  const wantsUs = keys.some((k) => US_KEYS.has(k));
  return jobs.filter((j) => {
    const loc = j.location.trim();
    if (!loc) return true;
    return res.some((re) => re.test(loc)) || (wantsUs && US_STATE_RE.test(loc));
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface AlertEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailRanking {
  scores: Record<string, number>;
  notes: Record<string, { fit: number; why: string; gap: string }>;
}

const shortDate = (j: DiscoveredJob, timeZone?: string) => {
  const d = j.postedAt ? new Date(j.postedAt) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) })
    : "Not given";
};

/**
 * The daily email: a summary line, then two tables, Entry (clear matches) and
 * Maybe (borderline), each sorted by resume match when there is a ranking.
 */
export function renderEmail(
  jobs: DiscoveredJob[],
  opts: {
    date: Date;
    failed?: string[];
    firstRun?: boolean;
    ranking?: EmailRanking | null;
    rankingError?: string;
    /** Only jobs posted in the last N days were included (0 or unset = no age filter). */
    maxAgeDays?: number;
    timeZone?: string;
    /** How many matching jobs are open in total (for the summary line). */
    openMatches?: number;
  }
): AlertEmail {
  const ranked = Boolean(opts.ranking && Object.keys(opts.ranking.scores).length);
  const score = (j: DiscoveredJob) => opts.ranking?.scores[j.id] ?? 0;
  const order = (a: DiscoveredJob, b: DiscoveredJob) =>
    (ranked ? score(b) - score(a) : 0) || a.companyName.localeCompare(b.companyName) || a.title.localeCompare(b.title);
  const entryJobs = jobs.filter((j) => j.level === "entry").sort(order);
  const maybeJobs = jobs.filter((j) => j.level !== "entry").sort(order);
  const day = opts.date.toLocaleDateString("en-CA", opts.timeZone ? { timeZone: opts.timeZone } : {});
  const best = ranked ? [...entryJobs, ...maybeJobs].sort((a, b) => score(b) - score(a))[0] : undefined;

  const subject =
    `Entry-level SWE jobs · ${entryJobs.length} entry · ${maybeJobs.length} maybe` +
    (best ? ` · best match: ${best.companyName} (${score(best)})` : "") +
    ` · ${day}`;

  const summary =
    `${entryJobs.length} entry · ${maybeJobs.length} maybe` +
    ((opts.maxAgeDays ?? 0) > 0 ? " · newly posted since the last email" : opts.firstRun ? " · first run: every open match" : " · new since the last email") +
    (opts.openMatches !== undefined ? ` · ${opts.openMatches} matching roles open in total` : "");

  const notes: string[] = [];
  if (opts.failed?.length) notes.push(`Couldn't read today: ${opts.failed.join(", ")}. They'll be tried again next time.`);
  if (ranked) notes.push("Match = how close the job description is to your resume (embedding similarity, 0-100). It ranks jobs against each other; it isn't a probability.");
  if (opts.rankingError) notes.push(`Ranking by resume wasn't available today: ${opts.rankingError}`);

  const sections = [
    { title: "Entry — clear early-career matches", jobs: entryJobs.slice(0, MAX_LISTED), more: Math.max(0, entryJobs.length - MAX_LISTED) },
    { title: "Maybe — borderline", jobs: maybeJobs.slice(0, MAX_LISTED), more: Math.max(0, maybeJobs.length - MAX_LISTED) },
  ];

  // ---------- plain text ----------
  const textLines = [`Entry-level SWE jobs — ${day}`, summary, ""];
  for (const sec of sections) {
    textLines.push(`${sec.title.toUpperCase()} (${sec.jobs.length + sec.more})`, "");
    if (!sec.jobs.length) textLines.push("(none today)", "");
    for (const j of sec.jobs) {
      textLines.push(`- ${ranked ? `[Match ${score(j)}] ` : ""}${j.companyName}: ${j.title}`);
      textLines.push(`  ${j.location || "Location not listed"} · ${j.category} · Posted ${shortDate(j, opts.timeZone)}`);
      const note = opts.ranking?.notes[j.id];
      if (note) textLines.push(`  Why: ${note.why}`, ...(note.gap ? [`  Gap: ${note.gap}`] : []));
      textLines.push(`  Rule: ${j.reasons.join("; ")}`, `  ${j.url}`, "");
    }
    if (sec.more) textLines.push(`…and ${sec.more} more.`, "");
  }
  textLines.push(...notes);
  const text = textLines.join("\n");

  // ---------- HTML ----------
  const th = (t: string) => `<th style="text-align:left;padding:10px 8px;font-size:13px;white-space:nowrap">${t}</th>`;
  const td = (h: string, extra = "") => `<td style="padding:10px 8px;vertical-align:top;border-top:1px solid #e7e5e4;font-size:13px${extra}">${h}</td>`;
  const table = (list: DiscoveredJob[], head: string) => {
    const rows = list
      .map((j) => {
        const note = opts.ranking?.notes[j.id];
        const why =
          (note ? `✓ ${esc(note.why)}${note.gap ? `<br><span style="color:#78716c">△ ${esc(note.gap)}</span>` : ""}<br>` : "") +
          `<span style="color:#78716c">${esc(j.reasons.join("; "))}</span>`;
        return `<tr>
  ${td(`<b>${esc(j.companyName)}</b>`)}
  ${td(`<a href="${esc(j.url)}" style="color:#1d4ed8">${esc(j.title)}</a>`, ";min-width:160px")}
  ${td(esc(j.location || "Not listed"))}
  ${td(esc(j.category), ";white-space:nowrap")}
  ${td(esc(shortDate(j, opts.timeZone)), ";white-space:nowrap")}
  ${ranked ? td(`<b>${score(j)}</b>`, ";text-align:center") : ""}
  ${td(why, ";min-width:200px")}
</tr>`;
      })
      .join("\n");
    return `<table style="border-collapse:collapse;width:100%">
<tr style="background:${head}">${th("Company")}${th("Role")}${th("Location")}${th("Type")}${th("Posted")}${ranked ? th("Match") : ""}${th("Why")}</tr>
${rows}
</table>`;
  };
  const sectionHtml = (sec: (typeof sections)[number], head: string) =>
    `<h3 style="margin:24px 0 8px;font-size:16px">${esc(sec.title)} (${sec.jobs.length + sec.more})</h3>` +
    (sec.jobs.length ? table(sec.jobs, head) : `<p style="color:#78716c;font-style:italic;margin:0">(none today)</p>`) +
    (sec.more ? `<p>…and ${sec.more} more.</p>` : "");

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#1c1917;max-width:960px">
<h2 style="margin:0 0 6px;font-size:20px">Entry-level SWE Jobs — ${esc(day)}</h2>
<p style="margin:0;color:#57534e"><b style="color:#15803d">${entryJobs.length} entry</b> · ${esc(summary.replace(/^\d+ entry · /, ""))}</p>
${sectionHtml(sections[0], "#dcfce7")}
${sectionHtml(sections[1], "#fef9c3")}
${notes.map((n) => `<p style="color:#78716c;font-size:12px;margin:16px 0 0">${esc(n)}</p>`).join("\n")}
<p style="color:#a8a29e;font-size:12px">Sent by your Job Search Agent. Screening rules: src/core/discover/classify.ts</p>
</div>`;
  return { subject, text, html };
}
