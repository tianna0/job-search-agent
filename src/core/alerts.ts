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

/** Entry first, then by company and title. */
function sorted(jobs: DiscoveredJob[]): DiscoveredJob[] {
  return [...jobs].sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === "entry" ? -1 : 1) ||
      a.companyName.localeCompare(b.companyName) ||
      a.title.localeCompare(b.title)
  );
}

export interface EmailRanking {
  scores: Record<string, number>;
  notes: Record<string, { fit: number; why: string; gap: string }>;
}

const levelLabel = (j: DiscoveredJob) => (j.level === "entry" ? "Entry" : "Maybe");

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
  }
): AlertEmail {
  const ranked = Boolean(opts.ranking && Object.keys(opts.ranking.scores).length);
  const score = (j: DiscoveredJob) => opts.ranking?.scores[j.id] ?? 0;
  const list = ranked ? [...jobs].sort((a, b) => score(b) - score(a) || a.companyName.localeCompare(b.companyName)) : sorted(jobs);
  const entry = list.filter((j) => j.level === "entry").length;
  const maybe = list.length - entry;
  const day = opts.date.toISOString().slice(0, 10);
  const top = ranked ? list[0] : undefined;
  const subject =
    `${list.length} new job${list.length === 1 ? "" : "s"} for you (${entry} entry, ${maybe} maybe)` +
    (top ? ` · best match: ${top.companyName} (${score(top)})` : "") +
    ` · ${day}`;

  const shown = list.slice(0, MAX_LISTED);
  const more = list.length - shown.length;
  const fresh = (opts.maxAgeDays ?? 0) > 0;
  const intro = fresh
    ? "Newly posted matching jobs (posted since the last email, or first listed since then when the site doesn't give a date):"
    : opts.firstRun
      ? "First run: these are all the matching jobs open right now. From now on you'll only get new ones."
      : "New since the last email:";
  const posted = (j: DiscoveredJob) => postedLabel(j, opts.timeZone);
  const notes: string[] = [];
  if (opts.failed?.length) notes.push(`Couldn't read today: ${opts.failed.join(", ")}. They'll be tried again next time.`);
  if (ranked) notes.push("Match = how close the job description is to your resume (embedding similarity, 0-100). It ranks jobs against each other; it isn't a probability.");
  if (opts.rankingError) notes.push(`Ranking by resume wasn't available today: ${opts.rankingError}`);

  // Groups: ranked -> top picks (have notes) + the rest; unranked -> entry + maybe.
  const groups: { title: string; jobs: DiscoveredJob[] }[] = ranked
    ? [
        { title: "Top picks for your resume", jobs: shown.filter((j) => opts.ranking!.notes[j.id]) },
        { title: "Other new jobs (closest match first)", jobs: shown.filter((j) => !opts.ranking!.notes[j.id]) },
      ]
    : [
        { title: "Entry level", jobs: shown.filter((j) => j.level === "entry") },
        { title: "Maybe (level II / 3-4 / 1-3 years)", jobs: shown.filter((j) => j.level === "maybe") },
      ];

  const tag = (j: DiscoveredJob) => (ranked ? `[Match ${score(j)} · ${levelLabel(j)}] ` : "");
  const textLines = [intro, ""];
  for (const g of groups) {
    if (!g.jobs.length) continue;
    textLines.push(g.title.toUpperCase(), "");
    for (const j of g.jobs) {
      textLines.push(`- ${tag(j)}${j.companyName}: ${j.title}`);
      const note = opts.ranking?.notes[j.id];
      if (note) textLines.push(`  Why: ${note.why}`, ...(note.gap ? [`  Gap: ${note.gap}`] : []));
      textLines.push(`  ${posted(j)} · ${j.location || "Location not listed"} · ${j.category} · ${j.reasons.join("; ")}`, `  ${j.url}`, "");
    }
  }
  if (more > 0) textLines.push(`…and ${more} more.`, "");
  textLines.push(...notes);
  const text = textLines.join("\n");

  const badge = (j: DiscoveredJob) =>
    ranked
      ? `<span style="display:inline-block;min-width:34px;text-align:center;background:#fff7ed;color:#c2410c;border:1px solid #fdba74;border-radius:999px;font-size:12px;font-weight:600;padding:0 6px;margin-right:6px">${score(j)}</span>`
      : "";
  const section = (g: { title: string; jobs: DiscoveredJob[] }) => {
    if (!g.jobs.length) return "";
    const rows = g.jobs
      .map((j) => {
        const note = opts.ranking?.notes[j.id];
        const noteHtml = note
          ? `<br><span style="font-size:13px">✓ ${esc(note.why)}</span>${note.gap ? `<br><span style="font-size:13px;color:#78716c">△ ${esc(note.gap)}</span>` : ""}`
          : "";
        return `<tr>
  <td style="padding:8px 12px 8px 0;vertical-align:top;font-weight:600;white-space:nowrap">${badge(j)}${esc(j.companyName)}</td>
  <td style="padding:8px 0;vertical-align:top"><a href="${esc(j.url)}" style="color:#c2410c">${esc(j.title)}</a>${noteHtml}<br>
  <span style="color:#78716c;font-size:13px">${esc(posted(j))} · ${esc(levelLabel(j))} · ${esc(j.location || "Location not listed")} · ${esc(j.category)} · ${esc(j.reasons.join("; "))}</span></td>
</tr>`;
      })
      .join("\n");
    return `<h3 style="margin:20px 0 4px;font-size:16px">${esc(g.title)}</h3><table style="border-collapse:collapse">${rows}</table>`;
  };
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#1c1917;max-width:720px">
<p>${esc(intro)}</p>
${groups.map(section).join("\n")}
${more > 0 ? `<p>…and ${more} more.</p>` : ""}
${notes.map((n) => `<p style="color:#78716c;font-size:13px">${esc(n)}</p>`).join("\n")}
<p style="color:#a8a29e;font-size:12px">Sent by your Job Tracker. Screening rules: src/core/discover/classify.ts</p>
</div>`;
  return { subject, text, html };
}
