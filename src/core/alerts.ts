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

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ")
);
const US_KEYS = new Set(["us", "usa", "u.s.", "united states", "united states of america"]);
/** Countries that show up on these boards. A place naming one of them is not in the US. */
const FOREIGN =
  /\b(india|canada|united kingdom|england|scotland|ireland|germany|france|netherlands|spain|portugal|poland|switzerland|sweden|denmark|norway|finland|israel|singapore|japan|china|hong kong|taiwan|korea|australia|new zealand|brazil|mexico|argentina|colombia|chile|philippines|vietnam|indonesia|malaysia|thailand|uae|united arab emirates|saudi arabia|egypt|nigeria|kenya|south africa|romania|czech|serbia|ukraine|turkey|italy|belgium|austria|luxembourg|estonia|lithuania|latvia|greece|hungary|costa rica|uruguay|peru)\b|\b(bengaluru|bangalore|hyderabad|pune|mumbai|chennai|gurgaon|gurugram|noida|new delhi|delhi|kolkata|ahmedabad|toronto|vancouver|montreal|ottawa|waterloo|london|dublin|berlin|munich|paris|amsterdam|tel aviv|tokyo|sydney|melbourne|sao paulo|são paulo|mexico city|warsaw|krakow|bucharest|zurich|stockholm|copenhagen|aarhus|barcelona|madrid|lisbon|seoul|shanghai|beijing|shenzhen|manila)\b/i;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A location string may list several places: "Bengaluru, India; Seattle, WA". */
function places(location: string): string[] {
  return location.split(/;|\||\n|\s\/\s|\s+or\s+/i).map((p) => p.trim()).filter(Boolean);
}

/**
 * Is one place in the US, judging by its shape?
 *   "Seattle, WA" / "Seattle, WA, USA" / "US-CA-Menlo Park" / "US, CA, Santa Clara" -> yes
 *   "Bengaluru, KA, IN" (IN = India, after a region code) / "Toronto, ON, CA" -> no
 */
function looksUs(place: string): boolean {
  if (FOREIGN.test(place)) return false;
  const parts = place.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2];
    // "City, XX, YY": YY is a country code after a region code.
    if (/^[A-Z]{2,3}$/.test(last) && /^[A-Z]{2}$/.test(prev)) return last === "US" || last === "USA";
    if (US_STATES.has(last)) return true; // "City, ST"
  }
  return /^US[-,\s]/.test(place); // Workday style: "US-CA-Menlo Park", "US, CA, Santa Clara"
}

/**
 * Keep jobs where at least one listed place matches: a keyword as a whole word
 * ("US" matches "Remote - US" but not "Aarhus"), or, when a keyword means the US,
 * a place shaped like a US address. A place naming another country never counts
 * as US through its shape. Jobs with no location are kept.
 */
export function filterByLocation(jobs: DiscoveredJob[], keywords: string[]): DiscoveredJob[] {
  const keys = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return jobs;
  const res = keys.map((k) => new RegExp(`(^|[^a-z0-9])${escRe(k)}(?![a-z0-9])`, "i"));
  const wantsUs = keys.some((k) => US_KEYS.has(k));
  return jobs.filter((j) => {
    const loc = j.location.trim();
    if (!loc) return true;
    return places(loc).some((p) => {
      // Keyword hits only count for the place they're in; "IN" in "Bengaluru, KA, IN" is not "US".
      if (res.some((re) => re.test(p))) return !(wantsUs && FOREIGN.test(p) && !/\b(usa|united states)\b/i.test(p));
      return wantsUs && looksUs(p);
    });
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
  // Palette: Antique Green (Pantone 18-5418) and Creole Pink (Pantone 13-1407).
  const GREEN = "#3E6D69", PINK = "#F5D6CF", PINK_SOFT = "#FBEDE9", INK = "#24302F", MUTED = "#6B7F7C", LINE = "#EAD9D3";
  const th = (t: string, color: string) =>
    `<th style="text-align:left;padding:10px 10px;font-size:12px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;color:${color}">${t}</th>`;
  const td = (h: string, extra = "") => `<td style="padding:11px 10px;vertical-align:top;border-top:1px solid ${LINE};font-size:13px;color:${INK}${extra}">${h}</td>`;
  const table = (list: DiscoveredJob[], headBg: string, headText: string) => {
    const rows = list
      .map((j) => {
        const note = opts.ranking?.notes[j.id];
        const why =
          (note ? `<span style="color:${GREEN}">✓ ${esc(note.why)}</span>${note.gap ? `<br><span style="color:${MUTED}">△ ${esc(note.gap)}</span>` : ""}<br>` : "") +
          `<span style="color:${MUTED};font-size:12px">${esc(j.reasons.join("; "))}</span>`;
        return `<tr>
  ${td(`<b>${esc(j.companyName)}</b>`)}
  ${td(`<a href="${esc(j.url)}" style="color:${GREEN};font-weight:600;text-decoration:none;border-bottom:1px solid ${PINK}">${esc(j.title)}</a>`, ";min-width:160px")}
  ${td(esc(j.location || "Not listed"))}
  ${td(esc(j.category), ";white-space:nowrap")}
  ${td(esc(shortDate(j, opts.timeZone)), ";white-space:nowrap")}
  ${ranked ? td(`<span style="display:inline-block;min-width:30px;text-align:center;background:${PINK};color:${GREEN};font-weight:700;border-radius:999px;padding:2px 8px">${score(j)}</span>`, ";text-align:center") : ""}
  ${td(why, ";min-width:200px")}
</tr>`;
      })
      .join("\n");
    return `<table style="border-collapse:collapse;width:100%;border:1px solid ${LINE};border-radius:8px;overflow:hidden">
<tr style="background:${headBg}">${th("Company", headText)}${th("Role", headText)}${th("Location", headText)}${th("Type", headText)}${th("Posted", headText)}${ranked ? th("Match", headText) : ""}${th("Why", headText)}</tr>
${rows}
</table>`;
  };
  const sectionHtml = (sec: (typeof sections)[number], headBg: string, headText: string) =>
    `<h3 style="margin:28px 0 10px;font-size:16px;color:${GREEN}">${esc(sec.title)} (${sec.jobs.length + sec.more})</h3>` +
    (sec.jobs.length ? table(sec.jobs, headBg, headText) : `<p style="color:${MUTED};font-style:italic;margin:0">(none today)</p>`) +
    (sec.more ? `<p style="color:${MUTED}">…and ${sec.more} more.</p>` : "");

  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:${INK};max-width:960px;background:#ffffff">
<div style="height:6px;background:${GREEN};border-radius:3px 3px 0 0"></div>
<div style="background:${PINK_SOFT};padding:18px 20px;border-radius:0 0 8px 8px">
<h2 style="margin:0 0 6px;font-size:21px;color:${GREEN}">Entry-level SWE Jobs — ${esc(day)}</h2>
<p style="margin:0;color:${MUTED}"><b style="color:${GREEN}">${entryJobs.length} entry</b> · ${esc(summary.replace(/^\d+ entry · /, ""))}</p>
</div>
${sectionHtml(sections[0], GREEN, "#ffffff")}
${sectionHtml(sections[1], PINK, GREEN)}
${notes.map((n) => `<p style="color:${MUTED};font-size:12px;margin:16px 0 0">${esc(n)}</p>`).join("\n")}
<p style="color:${MUTED};font-size:11px;opacity:.8;margin-top:12px">Sent by your Job Search Agent. Screening rules: src/core/discover/classify.ts</p>
</div>`;
  return { subject, text, html };
}
