// Rule-based screening. No model calls, so it is free and fully testable.

export type Category =
  | "QA/SDET"
  | "SRE/DevOps"
  | "Platform/Infra"
  | "Full-stack"
  | "Frontend"
  | "Backend"
  | "SDE"
  | "SWE";

export type Level = "entry" | "maybe" | "excluded" | "unknown";

export interface Classification {
  category: Category | null;
  level: Level;
  reasons: string[];
}

// Order matters: the first group that matches wins, so the narrower groups
// (e.g. "software development engineer in test") come before the broad ones.
const CATEGORY_RULES: [Category, RegExp][] = [
  [
    "QA/SDET",
    /\bsdet\b|software (development )?engineer(s)? in test|software (quality|test) engineer|quality assurance engineer|\bqa engineer|test automation|\btest engineer|\b(software|systems?|qa) validation engineer/i,
  ],
  ["SRE/DevOps", /site reliability engineer|\bsre\b|dev[\s-]?ops engineer|\bdevops\b/i],
  // Platform and infrastructure roles, e.g. "Platform Engineer", "Infrastructure Engineer, Compute".
  // "Member of Technical Staff" on its own is deliberately not a category.
  ["Platform/Infra", /\bplatform engineer|\binfrastructure engineer|\bproduction engineer|\bcloud engineer/i],
  ["Full-stack", /full[\s-]?stack/i],
  ["Frontend", /front[\s-]?end|\bui software/i],
  ["Backend", /back[\s-]?end/i],
  ["SDE", /software (development|dev|developer) engineer|\bsoftware developer\b|\bsde\b/i],
  ["SWE", /software engineer/i],
];

export function categorize(title: string): Category | null {
  for (const [name, re] of CATEGORY_RULES) if (re.test(title)) return name;
  return null;
}

// "Member of Technical Staff" is a normal engineering title, not "Staff".
function normalizeTitle(title: string): string {
  return title.replace(/member of (the )?technical staff/gi, "MTS");
}

const TITLE_EXCLUDE =
  /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|intern(s|ship)?)\b/i;

const TITLE_ENTRY = new RegExp(
  [
    "new[\\s-]?grad",
    "new college grad",
    "university grad",
    "recent grad",
    "early career",
    "entry[\\s-]?level",
    "graduate (role|program|engineer|software)",
    "\\bgraduate\\b",
    "\\bjunior\\b",
    "associate software engineer",
    "software (development |dev |developer )?engineer[\\s,:-]*(i|1)\\b",
    "\\bsde[\\s,:-]*(i|1)\\b",
  ].join("|"),
  "i"
);

// "Software Engineer 3/4" is how some companies (e.g. Netflix) write levels 3/4.
const TITLE_MAYBE =
  /software (development |dev |developer )?engineer[\s,:-]*(ii|2|3|4)\b|\bsde[\s,:-]*(ii|2)\b|\bic3\b|\blevel[\s-]*[34]\b|\bl[34]\b|\bMTS\b/i;

const JD_CLEARANCE =
  /(security|secret|top secret|active) clearance|ts\/sci|must be (a )?(u\.?s\.? )?citizen|u\.?s\.? citizenship (is )?(required|needed)|requires? (u\.?s\.? )?citizenship|citizenship requirement/i;

const JD_NO_EXPERIENCE =
  /no (prior |previous )?(professional |work |industry )?experience (is )?(required|necessary|needed)/i;

const JD_ENTRY_WORDS = /new[\s-]?grad|new college grad|university grad|recent grad|early career/i;

// Section headings. Only the required part of a JD can exclude a job; what's
// under "Preferred qualifications" / "Nice to have" never does.
const PREFERRED_HEADING =
  /^\W*(preferred|desired|bonus|nice[\s-]to[\s-]haves?|pluses|extra credit|ideal(ly)?|it'?s? (would be )?(a plus|great|nice) if|we'?d love|even better|you might also have|additional (preferred )?qualifications)\b/i;
const OTHER_HEADING =
  /^\W*(minimum|basic|required|requirements|qualifications|what you('ll)? (need|bring)|who you are|you (have|bring|are)|about|responsibilities|what you('ll)? do|the role|benefits|compensation|pay|salary|why join|our|we offer|perks|location)\b/i;
// A sentence that marks itself optional: "5+ years is a plus", "ideally 4 years".
const OPTIONAL_SENTENCE = /\b(preferred|is a plus|a plus\b|nice to have|bonus|ideally|desired|would be great)\b/i;

/**
 * The part of a JD that states requirements: everything except preferred /
 * nice-to-have sections and sentences that call themselves optional.
 * Headings are recognized as short lines; a JD with no headings is used whole.
 */
export function requiredText(text: string): string {
  const out: string[] = [];
  let preferred = false;
  for (const line of text.split(/\n/)) {
    const short = line.trim().length <= 80;
    if (short && PREFERRED_HEADING.test(line)) {
      preferred = true;
      continue;
    }
    if (short && OTHER_HEADING.test(line)) preferred = false;
    if (preferred) continue;
    // Drop sentences that say they're optional, keep the rest of the line.
    const kept = line
      .split(/(?<=[.;!?])\s+/)
      .filter((sentence) => !OPTIONAL_SENTENCE.test(sentence))
      .join(" ");
    if (kept.trim()) out.push(kept);
  }
  return out.join("\n");
}

interface YearsMention {
  lo: number;
  hi: number | null;
}

/** Find "N years" / "N-M years" mentions that are about experience. */
export function yearsMentions(text: string): YearsMention[] {
  const out: YearsMention[] = [];
  const re = /(\d{1,2})\s*(?:\+|\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
    if (!/experience|exp\./i.test(around)) continue;
    out.push({ lo: Number(m[1]), hi: m[2] ? Number(m[2]) : null });
  }
  return out;
}

// Experience thresholds (years, the lower bound a JD asks for).
const EXCLUDE_YEARS = 5; // 5+ years: not early career
const MAYBE_YEARS = 3; // 3-4 years: worth a look

export function classify(title: string, description = ""): Classification {
  const reasons: string[] = [];
  const category = categorize(title);
  const t = normalizeTitle(title);
  const required = description ? requiredText(description) : "";

  if (TITLE_EXCLUDE.test(t)) {
    const hit = t.match(TITLE_EXCLUDE)![0];
    return { category, level: "excluded", reasons: [`title has "${hit}"`] };
  }
  if (required && JD_CLEARANCE.test(required)) {
    return { category, level: "excluded", reasons: ["clearance or citizenship requirement"] };
  }

  let entry = false;
  let maybe = false;
  // A 3-4 year minimum makes a job a Maybe even when the title says entry level.
  let needsYears = false;

  if (TITLE_ENTRY.test(t)) {
    entry = true;
    reasons.push(`title: ${t.match(TITLE_ENTRY)![0].trim()}`);
  } else if (TITLE_MAYBE.test(t)) {
    maybe = true;
    reasons.push(`title: ${t.match(TITLE_MAYBE)![0].trim()}`);
  }

  for (const y of yearsMentions(required)) {
    if (y.lo >= EXCLUDE_YEARS) {
      return { category, level: "excluded", reasons: [`${y.lo}+ years of experience required`] };
    }
    if (y.lo >= MAYBE_YEARS) {
      needsYears = true;
      reasons.push(`JD: ${y.lo}${y.hi !== null ? "-" + y.hi : "+"} years`);
    } else if (y.hi !== null && y.hi >= MAYBE_YEARS) {
      maybe = true;
      reasons.push(`JD: ${y.lo}-${y.hi} years`);
    } else {
      entry = true;
      reasons.push(`JD: ${y.lo}${y.hi !== null ? "-" + y.hi : "+"} years`);
    }
  }
  if (JD_NO_EXPERIENCE.test(required)) {
    entry = true;
    reasons.push("JD: no experience required");
  }
  if (!entry && !maybe && !needsYears && JD_ENTRY_WORDS.test(description)) {
    entry = true;
    reasons.push("JD mentions new grads or early career");
  }

  // A JD range like "1-3 years" demotes an otherwise entry-level title.
  let level: Level = needsYears
    ? "maybe"
    : maybe && !TITLE_ENTRY.test(t) ? "maybe" : entry ? "entry" : maybe ? "maybe" : "unknown";
  // A plain title whose description we read but that never says how much
  // experience it wants: worth a look, so it's a Maybe. Without a description
  // (title-only screening) it stays unknown so the description gets fetched.
  if (level === "unknown" && category && description.trim()) {
    level = "maybe";
    reasons.push("JD doesn't state years of experience");
  }
  return { category, level, reasons: [...new Set(reasons)] };
}
