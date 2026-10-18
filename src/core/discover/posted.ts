// Posting dates come in many shapes. These turn them into ISO strings, or
// undefined when there's nothing usable, so a bad date never breaks a scan.

/**
 * Accepts epoch seconds or milliseconds (number or numeric string), ISO strings,
 * and readable dates like "October 10, 2026" or "Oct 10, 2026".
 */
export function toIsoDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  let ms: number;
  if (typeof value === "number" || (typeof value === "string" && /^\d{9,13}$/.test(value.trim()))) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n; // seconds vs milliseconds
  } else if (typeof value === "string") {
    ms = Date.parse(value.trim());
  } else {
    return undefined;
  }
  // Ignore nonsense (before 2000 or more than a day in the future).
  if (!Number.isFinite(ms) || ms < 946684800000 || ms > Date.now() + 86400000) return undefined;
  return new Date(ms).toISOString();
}

/** The first usable date among several candidate fields. */
export function firstDate(...values: unknown[]): string | undefined {
  for (const v of values) {
    const d = toIsoDate(v);
    if (d) return d;
  }
  return undefined;
}

/** Workday's "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago". */
export function workdayPosted(text: unknown, now = Date.now()): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.toLowerCase();
  let days: number | undefined;
  if (/\btoday\b/.test(t)) days = 0;
  else if (/\byesterday\b/.test(t)) days = 1;
  else {
    const m = t.match(/(\d+)\+?\s*days?\s*ago/);
    if (m) days = Number(m[1]);
  }
  return days === undefined ? undefined : new Date(now - days * 86400000).toISOString();
}
